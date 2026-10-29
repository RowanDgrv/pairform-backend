// =============================================================================
//  Edge Function : coach-needs (29/10/2026)
//  Écran « Qui a besoin de toi » : pour chaque athlète actif du coach
//  appelant, la liste des raisons de le contacter, triée par urgence.
//
//  Signaux (calcul commun avec l'alerte de 9 h, _shared/athleteSignals.ts) :
//    injured / sick / tired       dispo du dernier check-in (≤ 3 jours)
//    low_readiness                forme du dernier check-in < 50 (≤ 2 jours)
//    missed                       séances prévues non réalisées d'affilée
//    inactive                     aucune activité montre depuis ≥ 7 jours
//                                 alors que des séances étaient prévues
//    next_week_empty              aucune séance la semaine prochaine
//                                 (à partir du jeudi)
//    no_checkin                   plus de check-in depuis ≥ 4 jours
//                                 (seulement s'il en faisait)
//  Le texte est construit côté app (i18n) à partir de `kind` + `params`.
//
//  Auth : JWT ; renvoie UNIQUEMENT le roster de l'appelant (coach_athlete
//  actif), lu en service_role après ce filtre.
// =============================================================================
import { admin, corsHeaders, json, userFromReq } from "../_shared/providers.ts";
import { addDays, computeSignals, parisDay } from "../_shared/athleteSignals.ts";

type Item = { kind: string; level: "urgent" | "alert" | "warn" | "info"; sig: string; params?: Record<string, unknown> };
// sig : identifie l'événement (pas le jour) ; « traité » côté app tient tant que sig ne change pas.
const WEIGHT = { urgent: 100, alert: 40, warn: 15, info: 5 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "unauthenticated" }, 401);

    const { data: roster } = await sb.from("coach_athlete")
      .select("athlete_id").eq("coach_id", user.id).eq("status", "active");
    const ids = (roster ?? []).map((r: any) => r.athlete_id);
    const today = parisDay(new Date());
    const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = lundi
    const daysSince = (iso: string) => Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);

    const signals = await computeSignals(sb, ids, today, 21);
    const athletes = signals.map((g) => {
      const items: Item[] = [];
      const ck = g.lastCheckin;
      if (ck && daysSince(ck.date) <= 3) {
        if (ck.dispo === "blesse") items.push({ kind: "injured", level: "urgent", sig: ck.date, params: { date: ck.date, note: ck.note } });
        else if (ck.dispo === "malade") items.push({ kind: "sick", level: "alert", sig: ck.date, params: { date: ck.date, note: ck.note } });
        else if (ck.dispo === "fatigue") items.push({ kind: "tired", level: "warn", sig: ck.date, params: { date: ck.date } });
      }
      if (ck && daysSince(ck.date) <= 2 && ck.readiness != null && ck.readiness < 50) {
        items.push({ kind: "low_readiness", level: ck.readiness < 30 ? "alert" : "warn", sig: ck.date, params: { readiness: ck.readiness } });
      }
      if (g.missedDates.length) {
        items.push({ kind: "missed", level: g.missedDates.length >= 2 ? "alert" : "warn", sig: g.missedDates[0], params: { n: g.missedDates.length, dates: g.missedDates } });
      }
      const since = g.lastActivity ? daysSince(g.lastActivity) : null;
      if ((since == null || since >= 7) && g.missedDates.length) {
        items.push({ kind: "inactive", level: "warn", sig: g.lastActivity ?? "never", params: { days: since } });
      }
      if (dow >= 3 && g.nextWeekPlanned === 0) {
        items.push({ kind: "next_week_empty", level: dow >= 5 ? "alert" : "warn", sig: addDays(today, 7 - dow), params: { monday: addDays(today, 7 - dow) } });
      }
      if (ck && daysSince(ck.date) >= 4) items.push({ kind: "no_checkin", level: "info", sig: ck.date, params: { days: daysSince(ck.date) } });
      const score = items.reduce((t, i) => t + WEIGHT[i.level], 0);
      return {
        athlete_id: g.athleteId, name: g.name, score, items,
        week: { planned: g.weekPlannedToDate, done: g.weekDoneToDate },
        last_activity: g.lastActivity,
      };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    return json({ today, athletes });
  } catch (e) {
    console.error(e);
    return json({ error: "server", detail: String(e).slice(0, 200) }, 500);
  }
});
