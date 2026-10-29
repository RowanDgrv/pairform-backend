// =============================================================================
//  _shared/athleteSignals.ts (29/10/2026)
//  ---------------------------------------------------------------------------
//  Signaux « cet athlète a besoin de son coach », calculés côté serveur pour
//  un roster entier en 4 requêtes. Partagé par :
//    - coach-missed-alert (alerte email/push de 9 h)
//    - coach-needs        (écran « Qui a besoin de toi »)
//  pour que l'écran et l'alerte comptent exactement de la même façon.
//
//  « Réalisée » = done (validation manuelle) OU activité montre de la même
//  famille de sport le même jour (Paris). Sans le second critère, chaque
//  séance faite avec la montre serait comptée manquée (done n'est posé en
//  base que par la validation manuelle).
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const TZ = "Europe/Paris";
const FAMILY: Record<string, string[]> = {
  swim: ["swim"], bike: ["bike"], run: ["run"], strength: ["strength"],
  tri: ["swim", "bike", "run"], hyrox: ["run", "strength", "hyrox"],
};

export function parisDay(d: Date): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function parisHour(d: Date): number {
  return +new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d) % 24;
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Lundi (ISO) de la semaine contenant `iso`. */
export function mondayOf(iso: string): string {
  const dow = (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

export type AthleteSignals = {
  athleteId: string;
  name: string;
  /** séances prévues non réalisées d'affilée (les plus récentes), dates croissantes */
  missedDates: string[];
  /** semaine en cours : prévues jusqu'à hier / réalisées parmi elles */
  weekPlannedToDate: number;
  weekDoneToDate: number;
  /** séances prévues la semaine prochaine */
  nextWeekPlanned: number;
  /** dernière activité montre (date Paris) ou null */
  lastActivity: string | null;
  /** dernier check-in */
  lastCheckin: { date: string; dispo: string | null; readiness: number | null; note: string | null } | null;
};

export async function computeSignals(sb: SupabaseClient, ids: string[], today: string, lookbackDays = 21): Promise<AthleteSignals[]> {
  if (!ids.length) return [];
  const from = addDays(today, -lookbackDays);
  const nextMon = addDays(mondayOf(today), 7), nextSun = addDays(nextMon, 6);
  const [{ data: sessions }, { data: acts }, { data: profs }, { data: cks }] = await Promise.all([
    sb.from("scheduled_sessions").select("athlete_id, date, disc, done, created_at")
      .in("athlete_id", ids).gte("date", from).lte("date", nextSun),
    sb.from("external_activities").select("user_id, disc, start_time")
      .in("user_id", ids).gte("start_time", addDays(from, -1) + "T00:00:00Z").is("duplicate_of", null),
    sb.from("profiles").select("id, full_name, first_name, last_name, email").in("id", ids),
    sb.from("checkins").select("athlete_id, date, dispo, dispo_note, readiness")
      .in("athlete_id", ids).gte("date", from).order("date", { ascending: false }),
  ]);

  const actSet = new Set<string>();
  const lastAct = new Map<string, string>();
  for (const a of acts ?? []) {
    const d = parisDay(new Date(a.start_time));
    actSet.add(`${a.user_id}|${d}|${a.disc}`);
    if (!lastAct.has(a.user_id) || lastAct.get(a.user_id)! < d) lastAct.set(a.user_id, d);
  }
  const nameOf = (id: string) => {
    const p = (profs ?? []).find((x) => x.id === id);
    return (p && ([p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || (p.email ?? "").split("@")[0])) || "Athlète";
  };
  const realised = (id: string, s: { date: string; disc: string; done: boolean }) =>
    s.done || (FAMILY[s.disc] ?? [s.disc]).some((f) => actSet.has(`${id}|${s.date}|${f}`));
  const monday = mondayOf(today);

  return ids.map((id) => {
    const mine = (sessions ?? []).filter((s) => s.athlete_id === id);
    // passé : séance ajoutée après sa date = historique complété par le coach
    const past = mine.filter((s) => s.date < today && parisDay(new Date(s.created_at)) <= s.date)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const missed: string[] = [];
    for (const s of past) { if (realised(id, s)) break; missed.push(s.date); }
    const week = past.filter((s) => s.date >= monday);
    const ck = (cks ?? []).find((c) => c.athlete_id === id);
    return {
      athleteId: id,
      name: nameOf(id),
      missedDates: missed.reverse(),
      weekPlannedToDate: week.length,
      weekDoneToDate: week.filter((s) => realised(id, s)).length,
      nextWeekPlanned: mine.filter((s) => s.date >= nextMon && s.date <= nextSun).length,
      lastActivity: lastAct.get(id) ?? null,
      lastCheckin: ck ? { date: ck.date, dispo: ck.dispo ?? null, readiness: ck.readiness ?? null, note: ck.dispo_note ?? null } : null,
    };
  });
}
