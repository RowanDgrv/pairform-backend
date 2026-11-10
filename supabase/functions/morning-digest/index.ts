// =============================================================================
//  Edge Function : morning-digest
//  La notification du matin de Sillance : séances du jour + matériel à prévoir
//  + rappel nutrition, envoyée par email (Resend) et/ou Web Push selon les
//  préférences de chaque athlète (table notification_prefs).
//
//  Déclencheur : pg_cron toutes les 15 min → POST avec header x-cron-secret.
//  Un utilisateur est servi quand SON heure locale (tz du profil) tombe dans
//  la fenêtre de 15 min de son heure choisie, une seule fois par jour
//  (last_sent_on). Pas de séance aujourd'hui → rien n'est envoyé.
//
//  Secrets : CRON_SECRET, VAPID_KEYS_JSON (paire JWK), VAPID_SUBJECT,
//            RESEND_API_KEY (optionnel — sans lui l'email est ignoré).
// =============================================================================
import { morningCopy } from "../_shared/morningCopy.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";
import { sendFcmPush } from "../_shared/fcm.ts";
import { sendApnsPush } from "../_shared/apns.ts";

const DISC_LABEL: Record<string, string> = {
  swim: "Natation", bike: "Vélo", run: "Course", strength: "Renfo", hyrox: "Hyrox", tri: "Triathlon",
};
const DISC_GEAR: Record<string, string[]> = {
  swim: ["maillot de bain", "bonnet", "lunettes"],
  bike: ["vélo", "casque", "tenue vélo", "bidon"],
  run: ["baskets", "tenue running"],
  strength: ["tapis", "tenue confortable"],
  hyrox: ["chaussures", "gants", "tenue", "eau"],
};
const GEAR_TAGS: Record<string, string> = {
  // plaquettes, pull-buoy, palmes… : via scheduled_sessions.gear (0088)
  "vma": "montre GPS", "vo2max": "montre GPS",
  "longue": "ravitaillement (gels/barres)",
};

type Session = { title: string; disc: string; dur: number; zone: string | null; shoe_id?: string | null; gear?: string[] | null };
// libellés du catalogue de matériel (miroir de sillance-equipment.js, FR)
const EQUIP_LABEL: Record<string, string> = {
  rain_jacket: "veste de pluie", headlamp: "lampe frontale", run_belt: "ceinture porte-flasques", trail_poles: "bâtons de trail",
  power_meter: "capteur de puissance", home_trainer: "home-trainer", bike_computer: "compteur GPS vélo", bike_lights: "éclairage vélo",
  paddles: "plaquettes", pullbuoy: "pull-buoy", fins: "palmes", snorkel: "tuba frontal", kickboard: "planche",
  ankle_band: "élastique de chevilles", drag_chute: "parachute", wetsuit: "combinaison néoprène",
  gps_watch: "montre GPS", hr_strap: "ceinture cardio",
  mobility_band: "élastique de mobilité", foam_roller: "rouleau de massage", dumbbells: "haltères", kettlebell: "kettlebell",
};

function fmtDur(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}
// shoes : id → nom des paires choisies par le coach (0086) — « baskets :
// Nike Pegasus 40 » au lieu de « baskets ». Une seule « montre GPS » (plus de
// « montre connectée » en doublon), plus de « pointes » (retour Rowan 03/11).
// owned : matériel déclaré par l'athlète (athlete_equipment, 0087) — ajoute
// la ceinture cardio aux séances intenses course/vélo, le capteur au vélo.
// --- météo (05/11/2026) ------------------------------------------------------
// Séance dehors : course, vélo hors home-trainer, triathlon. Natation et renfo
// exclus. Pas d'heure de séance en base : on regarde la journée (7 h - 20 h).
function hasOutdoor(sessions: Session[]): boolean {
  return sessions.some((s) => (s.disc === "run" || s.disc === "tri" ||
    (s.disc === "bike" && !/home.?trainer|\bht\b|zwift|rouleau/i.test(s.title || ""))));
}
// Position : celle que l'athlète a accepté de partager dans « Rappel du matin »
// (migration 0093), déjà arrondie à 0,1° (~10 km) par l'app. Seules ces
// coordonnées approximatives partent vers Open-Meteo, sans aucun identifiant.
// Pas d'accord ou pas de position → pas de règle météo. Requête à part et
// tolérante : si la colonne manque, le rappel part quand même, sans météo.
// (10/11/2026 : remplace le départ de la dernière sortie Strava.)
// deno-lint-ignore no-explicit-any
async function lastPosition(sb: any, uid: string): Promise<[number, number] | null> {
  const { data, error } = await sb.from("notification_prefs").select("weather_lat, weather_lon").eq("user_id", uid).maybeSingle();
  if (error || !data) return null;
  const lat = Number((data as { weather_lat: unknown }).weather_lat), lon = Number((data as { weather_lon: unknown }).weather_lon);
  if ((data as { weather_lat: unknown }).weather_lat == null || (data as { weather_lon: unknown }).weather_lon == null) return null;
  return isFinite(lat) && isFinite(lon) ? [lat, lon] : null;
}
// Pluie probable : probabilité ≥ 60 % sur au moins une heure entre 7 h et 20 h,
// ou cumul ≥ 1 mm. Erreur ou délai dépassé (3 s) → on n'ajoute rien.
// 10/11/2026 : on renvoie aussi la plage horaire de la pluie (première et
// dernière heure pluvieuse entre 7 h et 20 h) pour l'annoncer dans le mail :
// « La météo annonce de la pluie entre 16 h et 19 h ».
async function rainWindow(lat: number, lon: number, day: string): Promise<{ from: number; to: number } | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=precipitation_probability,precipitation&timezone=Europe%2FParis&start_date=${day}&end_date=${day}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    const t: string[] = j?.hourly?.time ?? [], pp: number[] = j?.hourly?.precipitation_probability ?? [], mm: number[] = j?.hourly?.precipitation ?? [];
    let maxP = 0, sum = 0; const wet: number[] = [];
    t.forEach((h, i) => {
      const hh = +h.slice(11, 13);
      if (hh >= 7 && hh <= 20) {
        maxP = Math.max(maxP, pp[i] ?? 0); sum += mm[i] ?? 0;
        if ((pp[i] ?? 0) >= 60 || (mm[i] ?? 0) >= 0.2) wet.push(hh);
      }
    });
    if (!(maxP >= 60 || sum >= 1) || !wet.length) return null;
    return { from: Math.min(...wet), to: Math.max(...wet) + 1 };
  } catch { return null; }
}

function gearFor(sessions: Session[], shoes: Map<string, string> = new Map(), owned: Set<string> = new Set()): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    const shoe = s.disc === "run" && s.shoe_id ? shoes.get(s.shoe_id) : undefined;
    (DISC_GEAR[s.disc] ?? []).forEach((g) => set.add(g === "baskets" && shoe ? `baskets : ${shoe}` : g));
    const t = (s.title ?? "").toLowerCase();
    for (const k in GEAR_TAGS) if (t.includes(k)) set.add(GEAR_TAGS[k]);
    if (["Z4", "Z5"].includes(s.zone ?? "") || /vma|vo2|seuil|intervalle|fractionn/i.test(t)) {
      set.add("montre GPS");
      if (["run", "bike"].includes(s.disc) && owned.has("hr_strap")) set.add(EQUIP_LABEL.hr_strap);
    }
    if (s.disc === "bike" && owned.has("power_meter")) set.add(EQUIP_LABEL.power_meter);
    for (const k of s.gear ?? []) set.add(EQUIP_LABEL[k] ?? k.replace(/^custom:/, "").replace(/-/g, " "));
  }
  return [...set];
}
function nutriFor(sessions: Session[]): string {
  const long = sessions.some((s) => (s.dur ?? 0) >= 120);
  const hard = sessions.some((s) => ["Z4", "Z5"].includes(s.zone ?? ""));
  if (long) return "prévois 30 à 60 g de glucides par heure (gels, barres, boisson).";
  if (hard) return "une collation glucidique 1 à 2 h avant, des protéines dans les 30 min après.";
  return "hydrate-toi bien tout au long de la journée.";
}

/* heure locale (h, min, date ISO) d'un fuseau donné */
function localNow(tz: string): { h: number; m: number; day: string } {
  try {
    const parts = new Intl.DateTimeFormat("fr-CA", {
      timeZone: tz, hour: "2-digit", minute: "2-digit",
      year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
    return { h: +g("hour") % 24, m: +g("minute"), day: `${g("year")}-${g("month")}-${g("day")}` };
  } catch {
    const d = new Date();
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // --- gate cron (fonction déployée sans verify_jwt) ---
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (!secret || req.headers.get("x-cron-secret") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Web Push prêt si les clés VAPID sont posées ---
    let appServer: webpush.ApplicationServer | null = null;
    const vapidJson = Deno.env.get("VAPID_KEYS_JSON");
    if (vapidJson) {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(vapidJson), { extractable: false });
      appServer = await webpush.ApplicationServer.new({
        contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:rowandegraeve@gmail.com",
        vapidKeys,
      });
    }

    const { data: prefs, error: pErr } = await supabase
      .from("notification_prefs")
      .select("user_id, send_hour, send_minute, tz, channel, last_sent_on")
      .neq("channel", "none");
    if (pErr) throw pErr;

    let sent = 0, skipped = 0, failed = 0;
    for (const p of prefs ?? []) {
      const now = localNow(p.tz || "Europe/Paris");
      const inWindow = now.h === p.send_hour && now.m >= p.send_minute && now.m < p.send_minute + 15;
      if (!inWindow || p.last_sent_on === now.day) { skipped++; continue; }

      // séances planifiées AUJOURD'HUI (heure locale de l'athlète)
      const { data: sessions } = await supabase
        .from("scheduled_sessions")
        .select("title, disc, dur, zone, shoe_id, gear, coach_note")
        .eq("athlete_id", p.user_id)
        .eq("date", now.day)
        .eq("done", false);
      if (!sessions?.length) { skipped++; continue; }

      const lines = sessions.map((s) =>
        `${DISC_LABEL[s.disc] ?? s.disc} : ${s.title}` +
        ` (${fmtDur(s.dur ?? 0)}${s.zone ? " · " + s.zone : ""})`
      );
      const shoeIds = [...new Set(sessions.map((s) => s.shoe_id).filter(Boolean))] as string[];
      const shoes = new Map<string, string>();
      if (shoeIds.length) {
        const { data: g } = await supabase.from("gear").select("id, name").in("id", shoeIds);
        (g ?? []).forEach((x) => shoes.set(x.id, x.name));
      }
      const { data: eq } = await supabase.from("athlete_equipment").select("item_key").eq("athlete_id", p.user_id);
      const owned = new Set((eq ?? []).map((r) => r.item_key as string));
      const gear = gearFor(sessions as Session[], shoes, owned);
      // Veste de pluie si pluie probable en journée et séance dehors (05/11/2026)
      let weatherLine = "";
      if (!gear.some((g) => g.startsWith("veste de pluie")) && hasOutdoor(sessions as Session[])) {
        const pos = await lastPosition(supabase, p.user_id);
        const rain = pos ? await rainWindow(pos[0], pos[1], now.day) : null;
        if (rain) {
          gear.push("veste de pluie (pluie prévue)");
          weatherLine = `La météo annonce de la pluie entre ${rain.from} h et ${rain.to} h : prévois ta veste de pluie.`;
        }
      }
      const nutri = nutriFor(sessions as Session[]);
      // Textes variés du jour (05/11/2026) : prénom de l'athlète, prénom du
      // coach qui signe, accroche selon la séance et le jour de la semaine.
      const { data: me } = await supabase.from("profiles").select("email, first_name, full_name").eq("id", p.user_id).single();
      const { data: link } = await supabase.from("coach_athlete").select("coach_id").eq("athlete_id", p.user_id).eq("status", "active").limit(1).maybeSingle();
      let coachFirst: string | null = null;
      if (link?.coach_id && link.coach_id !== p.user_id) {
        const { data: c } = await supabase.from("profiles").select("first_name, full_name").eq("id", link.coach_id).single();
        coachFirst = c?.first_name || (c?.full_name || "").split(" ")[0] || null;
      }
      const firstName = me?.first_name || (me?.full_name || "").split(" ")[0] || null;
      const copy = morningCopy(sessions as Session[], { firstName, coachFirstName: coachFirst, day: now.day, userId: p.user_id });
      const title = copy.subject;
      // commentaire du coach sur la séance (05/11/2026) : « Le mot de Rowan »
      const notes = (sessions as { coach_note?: string | null }[]).map((x) => (x.coach_note || "").trim()).filter(Boolean);
      const bodyTxt = `${copy.intro}\n\n${copy.gearLabel} ${gear.join(", ")}${weatherLine ? `\n${weatherLine}` : ""}${notes.length ? `\n\n${notes.join(" ")}` : ""}`;

      // Un athlète en erreur ne doit jamais bloquer les suivants (avant : une
      // exception sortait de la boucle → 500 → tous les athlètes restants
      // perdaient leur rappel du jour, la fenêtre de 15 min étant passée).
      // `delivered` ne compte que ce qui est VRAIMENT parti : sendEmail renvoie
      // false sans lever d'erreur quand Resend refuse ou n'est pas configuré
      // (constaté 27/10/2026 : RESEND_API_KEY absent, la fonction annonçait
      // sent:1 alors qu'aucun email n'était envoyé).
      try {
        const [emailOk, pushOk] = await Promise.all([
          (async () => {
            if (p.channel !== "email" && p.channel !== "both") return false;
            if (!me?.email) return false;
            return await sendEmail({
              to: me.email,
              subject: title,
              html: digestHtml(copy, lines, gear, nutri, notes, coachFirst, weatherLine),
            });
          })(),
          (async () => {
            if (p.channel !== "push" && p.channel !== "both") return false;
            const { data: subs } = await supabase.from("push_subscriptions")
              .select("id, endpoint, p256dh, auth, platform").eq("user_id", p.user_id);
            // Lu côté client au tap (silOnNotificationTap) pour amener directement
            // l'athlète sur sa vue plutôt que sur l'écran par défaut de l'app.
            const pushData = { type: "morning_digest" };
            let ok = false;
            for (const s of subs ?? []) {
              if (s.platform === "android") {
                const r = await sendFcmPush(s.endpoint, { title, body: bodyTxt, data: pushData });
                if (r.ok) ok = true;
                else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
                continue;
              }
              if (s.platform === "ios") {
                const r = await sendApnsPush(s.endpoint, { title, body: bodyTxt, data: pushData });
                if (r.ok) ok = true;
                else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
                continue;
              }
              if (!appServer) continue;
              try {
                const subscriber = appServer.subscribe({
                  endpoint: s.endpoint,
                  keys: { p256dh: s.p256dh, auth: s.auth },
                });
                await subscriber.pushTextMessage(JSON.stringify({
                  title, body: bodyTxt, url: "./sillance-app.html",
                }), {});
                ok = true;
              } catch (e) {
                // abonnement mort (navigateur désinscrit) → on le retire
                const msg = String(e);
                if (msg.includes("404") || msg.includes("410")) {
                  await supabase.from("push_subscriptions").delete().eq("id", s.id);
                } else console.warn("push KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
              }
            }
            return ok;
          })(),
        ]);

        if (emailOk || pushOk) {
          await supabase.from("notification_prefs")
            .update({ last_sent_on: now.day }).eq("user_id", p.user_id);
          sent++;
        } else {
          failed++;
          console.warn("morning-digest: rien n'a pu être envoyé à", p.user_id, "canal", p.channel);
        }
      } catch (e) {
        failed++;
        console.error("morning-digest: erreur pour", p.user_id, e);
      }
    }
    return json({ ok: true, sent, skipped, failed });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function digestHtml(copy: ReturnType<typeof morningCopy>, lines: string[], gear: string[], nutri: string, notes: string[] = [], coach: string | null = null, weatherLine = ""): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720;font-size:16px;line-height:1.6">
    <p>${escapeHtml(copy.greeting)}</p>
    <p>${copy.weekdayLine ? escapeHtml(copy.weekdayLine) + " " : ""}${escapeHtml(copy.intro)}</p>
    <ul style="line-height:1.7;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    <p><b>${escapeHtml(copy.gearLabel)}</b> ${gear.map(escapeHtml).join(", ")}</p>
    ${weatherLine ? `<p style="background:#eef4fb;border-radius:10px;padding:12px 14px">☔ ${escapeHtml(weatherLine)}</p>` : ""}
    <p style="background:#f0f7f4;border-radius:10px;padding:12px 14px"><b>${escapeHtml(copy.nutriLabel)}</b> ${escapeHtml(nutri)}</p>
    ${notes.length
      ? `<p style="border-left:3px solid #0B7285;padding:4px 0 4px 14px"><span style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0B7285;font-weight:700">Le mot de ${escapeHtml(coach || "ton coach")}</span><br>${notes.map(escapeHtml).join("<br>")}</p><p>${escapeHtml(copy.signature)}</p>`
      : `<p>${escapeHtml(copy.closing)}<br>${escapeHtml(copy.signature)}</p>`}
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Tu reçois ce mail car le rappel du matin est activé dans Sillance. Tu peux changer l'heure ou le couper à tout moment : <a href="https://sillance.app/sillance-app.html" style="color:#6b7682">mon rappel du matin</a>.</p>
  </div>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
