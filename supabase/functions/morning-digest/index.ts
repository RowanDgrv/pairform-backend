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
        .select("title, disc, dur, zone, shoe_id, gear")
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
      const bodyTxt = `${copy.intro}\n\n${copy.gearLabel} ${gear.join(", ")}`;

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
              html: digestHtml(copy, lines, gear, nutri),
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

function digestHtml(copy: ReturnType<typeof morningCopy>, lines: string[], gear: string[], nutri: string): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720;font-size:16px;line-height:1.6">
    <p>${escapeHtml(copy.greeting)}</p>
    <p>${copy.weekdayLine ? escapeHtml(copy.weekdayLine) + " " : ""}${escapeHtml(copy.intro)}</p>
    <ul style="line-height:1.7;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    <p><b>${escapeHtml(copy.gearLabel)}</b> ${gear.map(escapeHtml).join(", ")}</p>
    <p style="background:#f0f7f4;border-radius:10px;padding:12px 14px"><b>${escapeHtml(copy.nutriLabel)}</b> ${escapeHtml(nutri)}</p>
    <p>${escapeHtml(copy.closing)}<br>${escapeHtml(copy.signature)}</p>
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Tu reçois ce mail car le rappel du matin est activé dans Sillance. Tu peux changer l'heure ou le canal dans ton espace athlète.</p>
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
