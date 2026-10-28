// =============================================================================
//  Edge Function : coach-missed-alert
//  Prévient le coach quand un athlète enchaîne N séances prévues non
//  réalisées (N = profiles.missed_alert_threshold, 2 par défaut, NULL = coupé).
//  But : « X a manqué ses 2 dernières séances, prends des nouvelles ».
//
//  « Réalisée » = done (validation manuelle) OU activité montre de la même
//  famille de sport le même jour (heure de Paris). En base, done n'est posé
//  que par la validation manuelle ; le rapprochement montre n'existait que
//  dans l'app (linkRealisedToPlan) : sans ce second critère, chaque séance
//  faite avec la montre serait comptée manquée.
//
//  Ignorées : séances du jour (pas encore manquées), séances créées après
//  leur date (le coach complète un historique), plus de 21 jours.
//
//  Une alerte par série (clé = première séance manquée de la série, table
//  coach_missed_alerts_sent) : pas de relance quotidienne.
//
//  Déclencheur : pg_cron horaire (0077) ; envoi seulement à 9 h, Paris.
//  { "force": true, "coach_id": "…" } (avec le secret) : envoi immédiat pour
//  un coach, pour les tests.
//
//  Secrets : CRON_SECRET, RESEND_API_KEY, RESEND_FROM, APP_URL,
//            VAPID_KEYS_JSON, VAPID_SUBJECT, FCM_SERVICE_ACCOUNT_JSON, APNS_*.
// =============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendFcmPush } from "../_shared/fcm.ts";
import { sendApnsPush } from "../_shared/apns.ts";
import { sendEmail } from "../_shared/email.ts";

const SEND_HOUR = 9; // Europe/Paris
const LOOKBACK_DAYS = 21;
const TZ = "Europe/Paris";

/* familles de sport pour rapprocher séance prévue et activité montre */
const FAMILY: Record<string, string[]> = {
  swim: ["swim"], bike: ["bike"], run: ["run"], strength: ["strength"],
  tri: ["swim", "bike", "run"], hyrox: ["run", "strength", "hyrox"],
};

function parisParts(d: Date): { h: number; day: string } {
  const parts = new Intl.DateTimeFormat("fr-CA", {
    timeZone: TZ, hour: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { h: +g("hour") % 24, day: `${g("year")}-${g("month")}-${g("day")}` };
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayLabel(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

type Missed = { athleteId: string; name: string; count: number; streakStart: string; dates: string[] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const force = body?.force === true && typeof body?.coach_id === "string";

    const now = parisParts(new Date());
    if (!force && now.h !== SEND_HOUR) return json({ ok: true, skipped: "hors créneau", hour: now.h });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let appServer: webpush.ApplicationServer | null = null;
    const vapidJson = Deno.env.get("VAPID_KEYS_JSON");
    if (vapidJson) {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(vapidJson), { extractable: false });
      appServer = await webpush.ApplicationServer.new({
        contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:contact@sillance.app", vapidKeys,
      });
    }

    let q = supabase.from("profiles")
      .select("id, email, full_name, first_name, missed_alert_threshold, missed_alert_channel")
      .eq("role", "coach").not("missed_alert_threshold", "is", null);
    if (force) q = q.eq("id", body.coach_id);
    const { data: coaches, error: cErr } = await q;
    if (cErr) throw cErr;

    const appUrl = (Deno.env.get("APP_URL") ?? "https://sillance.app").replace(/\/$/, "");
    let sent = 0, nothing = 0, failed = 0;

    for (const coach of coaches ?? []) {
      // Un coach en erreur ne bloque jamais les suivants.
      try {
        const missed = await findMissed(supabase, coach.id, coach.missed_alert_threshold, now.day);
        if (!missed.length) { nothing++; continue; }

        const n = missed.length;
        const title = n === 1
          ? `${missed[0].name} a manqué ${missed[0].count} séances`
          : `${n} athlètes ont manqué des séances`;
        const bodyTxt = missed.map((m) => `${m.name} : ${m.count} d'affilée`).join(" · ") + ". Prends des nouvelles.";
        const ch = coach.missed_alert_channel ?? "email";

        const [emailOk, pushOk] = await Promise.all([
          (ch === "email" || ch === "both") && coach.email
            ? sendEmail({ to: coach.email, subject: `⚠️ ${title}`, html: alertHtml(coach.first_name || coach.full_name || "coach", missed, appUrl) })
            : Promise.resolve(false),
          ch === "push" || ch === "both"
            ? sendPush(supabase, appServer, coach.id, title, bodyTxt)
            : Promise.resolve(false),
        ]);

        if (emailOk || pushOk) {
          await supabase.from("coach_missed_alerts_sent").insert(missed.map((m) => ({
            coach_id: coach.id, athlete_id: m.athleteId, streak_start: m.streakStart, missed_count: m.count,
          })));
          sent++;
        } else {
          failed++;
          console.warn("coach-missed-alert: rien n'a pu être envoyé à", coach.id, "canal", ch);
        }
      } catch (e) {
        failed++;
        console.error("coach-missed-alert: erreur pour", coach.id, e);
      }
    }
    return json({ ok: true, sent, nothing, failed, force });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

/* Séries de séances manquées, par athlète actif du coach, non encore signalées. */
async function findMissed(supabase: SupabaseClient, coachId: string, threshold: number, today: string): Promise<Missed[]> {
  const { data: roster } = await supabase.from("coach_athlete")
    .select("athlete_id").eq("coach_id", coachId).eq("status", "active");
  const ids = (roster ?? []).map((r) => r.athlete_id);
  if (!ids.length) return [];

  const from = addDays(today, -LOOKBACK_DAYS);
  const [{ data: sessions }, { data: acts }, { data: profs }, { data: already }] = await Promise.all([
    supabase.from("scheduled_sessions").select("athlete_id, date, disc, done, created_at")
      .in("athlete_id", ids).gte("date", from).lt("date", today),
    supabase.from("external_activities").select("user_id, disc, start_time")
      .in("user_id", ids).gte("start_time", addDays(from, -1) + "T00:00:00Z").is("duplicate_of", null),
    supabase.from("profiles").select("id, full_name, first_name, last_name, email").in("id", ids),
    supabase.from("coach_missed_alerts_sent").select("athlete_id, streak_start").eq("coach_id", coachId).gte("streak_start", from),
  ]);

  const actSet = new Set((acts ?? []).map((a) => `${a.user_id}|${parisParts(new Date(a.start_time)).day}|${a.disc}`));
  const sentSet = new Set((already ?? []).map((a) => `${a.athlete_id}|${a.streak_start}`));
  const nameOf = (id: string) => {
    const p = (profs ?? []).find((x) => x.id === id);
    return (p && ([p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || (p.email ?? "").split("@")[0])) || "Un athlète";
  };

  const out: Missed[] = [];
  for (const id of ids) {
    const list = (sessions ?? [])
      .filter((s) => s.athlete_id === id)
      // créée après sa date : historique complété par le coach, pas une séance « manquée »
      .filter((s) => parisParts(new Date(s.created_at)).day <= s.date)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const dates: string[] = [];
    for (const s of list) {
      const realised = s.done || (FAMILY[s.disc] ?? [s.disc]).some((f) => actSet.has(`${id}|${s.date}|${f}`));
      if (realised) break;
      dates.push(s.date);
    }
    if (dates.length < threshold) continue;
    const streakStart = dates[dates.length - 1];
    if (sentSet.has(`${id}|${streakStart}`)) continue;
    out.push({ athleteId: id, name: nameOf(id), count: dates.length, streakStart, dates: dates.slice().reverse() });
  }
  return out;
}

async function sendPush(supabase: SupabaseClient, appServer: webpush.ApplicationServer | null, userId: string, title: string, body: string): Promise<boolean> {
  const { data: subs } = await supabase.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, platform").eq("user_id", userId);
  const data = { type: "coach_missed_alert" };
  let ok = false;
  for (const s of subs ?? []) {
    if (s.platform === "android" || s.platform === "ios") {
      const r = s.platform === "android"
        ? await sendFcmPush(s.endpoint, { title, body, data })
        : await sendApnsPush(s.endpoint, { title, body, data });
      if (r.ok) ok = true;
      else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
      continue;
    }
    if (!appServer) continue;
    try {
      const sub = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await sub.pushTextMessage(JSON.stringify({ title, body, url: "./sillance-app.html" }), {});
      ok = true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("404") || msg.includes("410")) await supabase.from("push_subscriptions").delete().eq("id", s.id);
      else console.warn("push coach-missed-alert KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
    }
  }
  return ok;
}

function alertHtml(name: string, missed: Missed[], appUrl: string): string {
  const rows = missed.map((m) =>
    `<li style="margin-bottom:6px"><b>${esc(m.name)}</b> : ${m.count} séances d'affilée non réalisées<br>
     <span style="color:#6b7682;font-size:13px">${m.dates.map(dayLabel).join(", ")}</span></li>`).join("");
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720">
    <h2 style="font-weight:800">Sillance : séances manquées</h2>
    <p>Salut ${esc(name)} ! ${missed.length > 1 ? "Ces athlètes ont" : "Cet athlète a"} enchaîné des séances prévues sans les réaliser :</p>
    <ul style="line-height:1.5;padding-left:20px">${rows}</ul>
    <p>Aucune activité montre ni validation pour ces séances. Ça vaut peut-être un message pour voir ce qui se passe (fatigue, blessure, emploi du temps).</p>
    <p style="margin:22px 0"><a href="${appUrl}/sillance-app.html" style="background:#0e7c8c;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">Ouvrir Sillance</a></p>
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Tu reçois cet email car l'alerte « séances manquées » est activée dans Sillance.
    Change le seuil, le canal ou coupe-la depuis ton espace coach.</p>
  </div>`;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
