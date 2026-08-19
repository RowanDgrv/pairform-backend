// =============================================================================
//  Edge Function : coach-week-reminder
//  Rappel au coach quand un de ses athlètes n'a pas encore sa semaine
//  suivante planifiée, à H-72 / H-48 / H-24 avant le jour deadline que CE
//  coach a choisi (profiles.week_deadline_day, vendredi/samedi/dimanche —
//  pas un jour fixe pour tous). Spec : SPEC-RAPPEL-PLANIF-COACH.md.
//
//  Déclencheur : pg_cron toutes les 15 min (même montage que morning-digest)
//  → POST avec header x-cron-secret. Un coach est servi quand SON heure
//  locale (Europe/Paris — pas encore de fuseau par coach, cf. notes spec)
//  tombe dans la fenêtre de 15 min d'un des 3 checkpoints, une fois par
//  semaine/checkpoint (dédup coach_week_reminders_sent).
//
//  "Semaine cible" = la semaine (lundi→dimanche) qui suit immédiatement le
//  jour deadline. "Pas planifiée" = un athlète actif du coach sans AUCUNE
//  ligne scheduled_sessions sur cette semaine (cf. spec §1.2, simplification
//  MVP assumée).
//
//  Secrets : CRON_SECRET (partagé avec morning-digest), VAPID_KEYS_JSON,
//            VAPID_SUBJECT, FCM_SERVICE_ACCOUNT_JSON, APNS_*.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendFcmPush } from "../_shared/fcm.ts";
import { sendApnsPush } from "../_shared/apns.ts";

const REMINDER_HOUR = 18; // heure fixe des 3 checkpoints (Europe/Paris) — cf. spec, question ouverte
const DEADLINE_DOW: Record<string, number> = { sunday: 0, friday: 5, saturday: 6 };
// écart (jours) entre le jour deadline et le lundi qui le suit immédiatement
const DAYS_TO_MONDAY: Record<string, number> = { sunday: 1, friday: 3, saturday: 2 };

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}
/* heure locale (h, min, date ISO) d'un fuseau donné — repris de morning-digest */
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
/* prochaine occurrence (>= aujourd'hui) du jour deadline, + la semaine cible qui en découle */
function nextDeadline(todayIso: string, deadlineDay: string): { deadline: string; weekMonday: string } {
  const today = new Date(todayIso + "T00:00:00Z");
  const targetDow = DEADLINE_DOW[deadlineDay];
  const diff = (targetDow - today.getUTCDay() + 7) % 7;
  const deadline = addDays(today, diff);
  const weekMonday = addDays(deadline, DAYS_TO_MONDAY[deadlineDay]);
  return { deadline: isoDate(deadline), weekMonday: isoDate(weekMonday) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (!secret || req.headers.get("x-cron-secret") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let appServer: webpush.ApplicationServer | null = null;
    const vapidJson = Deno.env.get("VAPID_KEYS_JSON");
    if (vapidJson) {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(vapidJson), { extractable: false });
      appServer = await webpush.ApplicationServer.new({
        contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:rowandegraeve@gmail.com",
        vapidKeys,
      });
    }

    const { data: coaches, error: cErr } = await supabase
      .from("profiles").select("id, full_name, week_deadline_day")
      .not("week_deadline_day", "is", null);
    if (cErr) throw cErr;

    const tz = "Europe/Paris";
    const now = localNow(tz);
    const inWindow = now.h === REMINDER_HOUR && now.m < 15;

    let sent = 0, skipped = 0;
    if (inWindow) {
      for (const coach of coaches ?? []) {
        const { deadline, weekMonday } = nextDeadline(now.day, coach.week_deadline_day);
        const daysToDeadline = Math.round(
          (new Date(deadline + "T00:00:00Z").getTime() - new Date(now.day + "T00:00:00Z").getTime()) / 86400000,
        );
        const checkpoint = daysToDeadline === 3 ? "h72" : daysToDeadline === 2 ? "h48" : daysToDeadline === 1 ? "h24" : null;
        if (!checkpoint) { skipped++; continue; }

        const { data: already } = await supabase.from("coach_week_reminders_sent")
          .select("checkpoint").eq("coach_id", coach.id).eq("week_monday", weekMonday).eq("checkpoint", checkpoint)
          .maybeSingle();
        if (already) { skipped++; continue; }

        const { data: roster } = await supabase.from("coach_athlete")
          .select("athlete_id").eq("coach_id", coach.id).eq("status", "active");
        if (!roster?.length) { skipped++; continue; }

        const athleteIds = roster.map((r) => r.athlete_id);
        const weekEnd = isoDate(addDays(new Date(weekMonday + "T00:00:00Z"), 6));
        const { data: planned } = await supabase.from("scheduled_sessions")
          .select("athlete_id").in("athlete_id", athleteIds).gte("date", weekMonday).lte("date", weekEnd);
        const plannedSet = new Set((planned ?? []).map((p) => p.athlete_id));
        const gapIds = athleteIds.filter((id) => !plannedSet.has(id));

        // toujours marquer le checkpoint traité, même sans gap : évite de
        // re-scanner ce coach à chaque tick des 15 minutes de la fenêtre.
        await supabase.from("coach_week_reminders_sent").insert({ coach_id: coach.id, week_monday: weekMonday, checkpoint });
        if (!gapIds.length) { skipped++; continue; }

        const { data: gapProfiles } = await supabase.from("profiles").select("full_name").in("id", gapIds);
        const names = (gapProfiles ?? []).map((p) => p.full_name).filter(Boolean);
        const tone = checkpoint === "h24" ? "Dernière ligne droite" : checkpoint === "h48" ? "Ça se rapproche" : "Petit rappel";
        const title = `${tone} — ${gapIds.length} athlète${gapIds.length > 1 ? "s" : ""} à planifier`;
        const bodyTxt = `${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""} n'ont pas encore leur semaine du ${weekMonday}.`;

        const { data: subs } = await supabase.from("push_subscriptions")
          .select("id, endpoint, p256dh, auth, platform").eq("user_id", coach.id);
        const pushData = { type: "coach_week_reminder", week_monday: weekMonday };

        for (const s of subs ?? []) {
          if (s.platform === "android") {
            const r = await sendFcmPush(s.endpoint, { title, body: bodyTxt, data: pushData });
            if (r.ok) sent++;
            else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
            continue;
          }
          if (s.platform === "ios") {
            const r = await sendApnsPush(s.endpoint, { title, body: bodyTxt, data: pushData });
            if (r.ok) sent++;
            else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
            continue;
          }
          if (!appServer) continue;
          try {
            const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
            await subscriber.pushTextMessage(JSON.stringify({ title, body: bodyTxt, url: "./sillance-app.html" }), {});
            sent++;
          } catch (e) {
            const msg = String(e);
            if (msg.includes("404") || msg.includes("410")) {
              await supabase.from("push_subscriptions").delete().eq("id", s.id);
            } else console.warn("push coach-week-reminder KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
          }
        }
      }
    }

    return json({ ok: true, sent, skipped, inWindow });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
