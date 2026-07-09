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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";

const DISC_LABEL: Record<string, string> = {
  swim: "Natation", bike: "Vélo", run: "Course", strength: "Renfo", hyrox: "Hyrox", tri: "Triathlon",
};
const DISC_GEAR: Record<string, string[]> = {
  swim: ["maillot de bain", "bonnet", "lunettes"],
  bike: ["vélo", "casque", "tenue vélo", "bidon"],
  run: ["chaussures de course", "tenue running"],
  strength: ["tapis", "tenue confortable"],
  hyrox: ["chaussures", "gants", "tenue", "eau"],
};
const GEAR_TAGS: Record<string, string> = {
  "plaquette": "plaquettes", "pull": "pull-buoy", "élastique": "élastique",
  "palme": "palmes", "tuba": "tuba", "ht": "home-trainer", "home trainer": "home-trainer",
  "piste": "pointes (piste)", "vma": "montre GPS", "vo2max": "montre GPS",
  "capteur": "capteur de puissance", "ftp": "capteur de puissance",
  "longue": "ravitaillement (gels/barres)",
};

type Session = { title: string; disc: string; dur: number; zone: string | null };

function fmtDur(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}
function gearFor(sessions: Session[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    (DISC_GEAR[s.disc] ?? []).forEach((g) => set.add(g));
    const t = (s.title ?? "").toLowerCase();
    for (const k in GEAR_TAGS) if (t.includes(k)) set.add(GEAR_TAGS[k]);
    if (["Z4", "Z5"].includes(s.zone ?? "") || /vma|vo2|seuil|intervalle|fractionn/i.test(t)) {
      set.add("montre connectée");
    }
  }
  return [...set];
}
function nutriFor(sessions: Session[]): string {
  const long = sessions.some((s) => (s.dur ?? 0) >= 120);
  const hard = sessions.some((s) => ["Z4", "Z5"].includes(s.zone ?? ""));
  if (long) return "Sortie longue aujourd'hui : prévois 30–60 g de glucides/heure (gels, barres, boisson).";
  if (hard) return "Séance intense : collation glucidique 1–2 h avant, protéines dans les 30 min après.";
  return "Hydrate-toi bien tout au long de la journée.";
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

    let sent = 0, skipped = 0;
    for (const p of prefs ?? []) {
      const now = localNow(p.tz || "Europe/Paris");
      const inWindow = now.h === p.send_hour && now.m >= p.send_minute && now.m < p.send_minute + 15;
      if (!inWindow || p.last_sent_on === now.day) { skipped++; continue; }

      // séances planifiées AUJOURD'HUI (heure locale de l'athlète)
      const { data: sessions } = await supabase
        .from("scheduled_sessions")
        .select("title, disc, dur, zone")
        .eq("athlete_id", p.user_id)
        .eq("date", now.day)
        .eq("done", false);
      if (!sessions?.length) { skipped++; continue; }

      const lines = sessions.map((s) =>
        `${DISC_LABEL[s.disc] ?? s.disc} — ${s.title}` +
        ` (${fmtDur(s.dur ?? 0)}${s.zone ? " · " + s.zone : ""})`
      );
      const gear = gearFor(sessions as Session[]);
      const nutri = nutriFor(sessions as Session[]);
      const title = sessions.length > 1
        ? `Ta journée Sillance — ${sessions.length} séances`
        : `Ta séance du jour — ${lines[0].split(" — ")[0]}`;
      const bodyTxt = `${lines.join("\n")}\n\nÀ prévoir : ${gear.join(", ")}\n${nutri}`;

      // --- email ---
      if (p.channel === "email" || p.channel === "both") {
        const { data: prof } = await supabase.from("profiles")
          .select("email, full_name").eq("id", p.user_id).single();
        if (prof?.email) {
          await sendEmail({
            to: prof.email,
            subject: `☀️ ${title}`,
            html: digestHtml(prof.full_name ?? "champion·ne", lines, gear, nutri),
          });
        }
      }

      // --- push (tous les appareils enregistrés) ---
      if (appServer && (p.channel === "push" || p.channel === "both")) {
        const { data: subs } = await supabase.from("push_subscriptions")
          .select("id, endpoint, p256dh, auth").eq("user_id", p.user_id);
        for (const s of subs ?? []) {
          try {
            const subscriber = appServer.subscribe({
              endpoint: s.endpoint,
              keys: { p256dh: s.p256dh, auth: s.auth },
            });
            await subscriber.pushTextMessage(JSON.stringify({
              title, body: bodyTxt, url: "./sillance-app.html",
            }), {});
          } catch (e) {
            // abonnement mort (navigateur désinscrit) → on le retire
            const msg = String(e);
            if (msg.includes("404") || msg.includes("410")) {
              await supabase.from("push_subscriptions").delete().eq("id", s.id);
            } else console.warn("push KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
          }
        }
      }

      await supabase.from("notification_prefs")
        .update({ last_sent_on: now.day }).eq("user_id", p.user_id);
      sent++;
    }
    return json({ ok: true, sent, skipped });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function digestHtml(name: string, lines: string[], gear: string[], nutri: string): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720">
    <h2 style="font-weight:800">Sillance — ton programme du jour</h2>
    <p>Salut ${escapeHtml(name)} ! Voilà ce qui t'attend aujourd'hui :</p>
    <ul style="line-height:1.7">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    <p style="margin-top:18px"><b>🎒 À prévoir :</b> ${gear.map(escapeHtml).join(" · ")}</p>
    <p style="background:#f0f7f4;border-radius:10px;padding:12px 14px">🥣 ${escapeHtml(nutri)}</p>
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Tu reçois cet email car le rappel du matin
    est activé dans Sillance. Change l'heure ou le canal dans ton espace athlète.</p>
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
