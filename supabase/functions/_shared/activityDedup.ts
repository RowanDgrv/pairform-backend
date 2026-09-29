// =============================================================================
//  Déduplication des activités entre plateformes (29/09/2026)
//  ---------------------------------------------------------------------------
//  Un athlète qui a Strava ET une montre connectée (Coros/Polar/Garmin) voit
//  souvent la MÊME séance remonter deux fois : la montre l'envoie à Strava
//  (relais) ET directement à Sillance via sa propre synchro. external_activities
//  n'a pas de clé commune entre plateformes (unique = provider+provider_
//  activity_id, différent pour chacune) — le seul rapprochement possible est
//  par proximité (même athlète, même discipline, heure de départ proche,
//  durée proche).
//
//  Règle demandée par Rowan : la marque de la montre gagne toujours sur
//  Strava (pas l'inverse) — c'est aussi elle qu'on utilise pour POUSSER les
//  séances prévues (voir pushPlannedSession, corosMcp.ts), donc c'est déjà
//  la source de vérité côté athlète.
//
//  Implémentation : marquage doux (duplicate_of), jamais de suppression —
//  le doublon reste en base (traçabilité, et pour redevenir canonique si un
//  rapprochement ultérieur change) mais le front (getActivities) ne montre
//  que les lignes duplicate_of IS NULL.
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Provider } from "./providers.ts";

const WATCH_PROVIDERS: Provider[] = ["garmin", "coros", "polar", "suunto", "wahoo"];
const MATCH_WINDOW_MS = 10 * 60 * 1000; // départs à ±10 min = même séance probable

/** Priorité : une montre bat toujours Strava. Entre deux montres (rare, deux
 *  appareils connectés), on ne tranche pas au hasard — on garde la première
 *  rencontrée dans le tri chronologique, stable d'un passage à l'autre. */
function pickCanonical(group: any[]): any {
  const watch = group.find((r) => WATCH_PROVIDERS.includes(r.provider as Provider));
  return watch ?? group[0];
}

/**
 * Reconstruit duplicate_of pour toutes les activités de `userId` dont le
 * départ est >= `sinceIso`. Idempotent — se relance après chaque import sans
 * effet de bord si rien n'a changé.
 */
export async function resolveActivityDuplicates(sb: SupabaseClient, userId: string, sinceIso: string) {
  const { data: rows, error } = await sb
    .from("external_activities")
    .select("id, provider, disc, start_time, duration_s, duplicate_of")
    .eq("user_id", userId)
    .gte("start_time", sinceIso)
    .order("start_time", { ascending: true });
  if (error || !rows || rows.length < 2) return;

  const used = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (used.has(a.id) || !a.start_time) continue;
    const group = [a];
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (used.has(b.id) || b.provider === a.provider || !b.start_time) continue;
      const dt = Math.abs(new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
      if (dt > MATCH_WINDOW_MS) continue;
      if (a.disc && b.disc && a.disc !== b.disc) continue;
      if (a.duration_s && b.duration_s) {
        const ratio = a.duration_s / b.duration_s;
        if (ratio < 0.75 || ratio > 1.25) continue;
      }
      group.push(b);
    }
    if (group.length < 2) continue;
    group.forEach((r) => used.add(r.id));

    const canonical = pickCanonical(group);
    for (const r of group) {
      const wantDupOf = r.id === canonical.id ? null : canonical.id;
      if (r.duplicate_of !== wantDupOf) {
        await sb.from("external_activities").update({ duplicate_of: wantDupOf }).eq("id", r.id);
      }
    }
  }
}
