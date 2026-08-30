// =============================================================================
//  intervals.icu — OAuth2 + normalisation des activités.
//  Doc OAuth : https://forum.intervals.icu/t/intervals-icu-oauth-support/2759
//  ---------------------------------------------------------------------------
//  Particularités vs Strava / Coros :
//   • PAS de refresh token — l'access_token ne périme pas ; une nouvelle
//     autorisation le remplace. Donc aucune logique de refresh ici.
//   • Échange du code : POST form-urlencoded { client_id, client_secret, code }.
//     Réponse : { token_type, access_token, scope, athlete: { id, name } }.
//   • Les activités reprennent le schéma Strava (type "Run"/"Ride"/"Swim"…,
//     champs moving_time / distance / total_elevation_gain / …) → on réutilise
//     discFromStrava pour la discipline.
//   • intervals.icu N'EXPOSE PAS les activités d'origine Strava via son API.
//     Toutes les autres sources (Garmin, Coros, Polar, Suunto, Wahoo, Zwift,
//     .FIT importé) remontent normalement.
//   • Pas de webhook pour les apps OAuth → import initial à la connexion +
//     sync manuelle (bouton "Synchroniser"). Un pull périodique pourra être
//     ajouté plus tard (pg_cron → device-sync élargi).
//   • App à faire approuver : https://intervals.icu/oauth/apply (le flux OAuth
//     ne fonctionne qu'une fois l'app validée par intervals.icu).
//   • Quotas OAuth : 100 requêtes / utilisateur / jour par défaut.
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { discFromStrava } from "./providers.ts";

export const INTERVALS = {
  authorizeUrl: "https://intervals.icu/oauth/authorize",
  tokenUrl: "https://intervals.icu/api/oauth/token",
  apiBase: "https://intervals.icu/api/v1",
  scope: "ACTIVITY:READ",
  clientId: () => Deno.env.get("INTERVALS_CLIENT_ID"),
  clientSecret: () => Deno.env.get("INTERVALS_CLIENT_SECRET"),
  ready: () => !!Deno.env.get("INTERVALS_CLIENT_ID"),
};

/** Activité intervals.icu → ligne external_activities (schéma proche de Strava,
 *  noms de champs défensifs ; le payload brut est conservé dans `raw`). */
export function normalizeIntervalsActivity(a: any, userId: string) {
  return {
    user_id: userId,
    provider: "intervals" as const,
    provider_activity_id: String(a.id),
    disc: discFromStrava(a.type ?? a.category ?? ""),
    name: a.name ?? null,
    start_time: a.start_date_local ?? a.start_date ?? null,
    duration_s: a.moving_time ?? a.elapsed_time ?? null,
    distance_m: a.distance ?? null,
    elevation_m: a.total_elevation_gain ?? a.icu_elevation_gain ?? null,
    avg_hr: a.average_heartrate ?? a.icu_average_hr ?? null,
    max_hr: a.max_heartrate ?? a.icu_max_hr ?? null,
    avg_power: a.average_watts ?? a.icu_average_watts ?? null,
    avg_speed: a.average_speed ?? null,
    calories: a.calories ?? a.icu_calories ?? null,
    raw: a,
  };
}

/** Échange le code d'autorisation intervals.icu contre un Bearer token. */
export async function intervalsExchangeCode(code: string): Promise<any> {
  const body = new URLSearchParams({
    client_id: INTERVALS.clientId()!,
    client_secret: INTERVALS.clientSecret()!,
    code,
  });
  const res = await fetch(INTERVALS.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`intervals token: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Importe les activités intervals.icu des `days` derniers jours (défaut 90).
 *  Pas de refresh : on utilise directement `conn.access_token` (déjà déchiffré
 *  par decryptConn). */
export async function intervalsImportRecent(
  sb: SupabaseClient,
  conn: any,
  days = 90,
): Promise<number> {
  const token = conn.access_token;
  if (!token) throw new Error("intervals: pas d'access_token en base");

  const newest = new Date();
  const oldest = new Date(newest.getTime() - days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const url =
    `${INTERVALS.apiBase}/athlete/0/activities?oldest=${iso(oldest)}&newest=${iso(newest)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`intervals activities: ${res.status} ${await res.text()}`);
  const acts = await res.json();
  if (!Array.isArray(acts) || acts.length === 0) return 0;

  const rows = acts.map((a) => normalizeIntervalsActivity(a, conn.user_id));
  const { error } = await sb.from("external_activities")
    .upsert(rows, { onConflict: "provider,provider_activity_id" });
  if (error) throw error;

  await sb.from("device_connections")
    .update({ last_sync_at: new Date().toISOString() })
    .eq("id", conn.id);
  return rows.length;
}

/** Révoque le Bearer côté intervals.icu (best-effort). */
export async function intervalsDisconnect(token: string): Promise<void> {
  if (!token) return;
  try {
    await fetch(`${INTERVALS.apiBase}/disconnect-app`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error("intervals disconnect-app:", e);
  }
}
