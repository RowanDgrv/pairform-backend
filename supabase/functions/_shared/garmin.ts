// =============================================================================
//  Garmin — Connect Developer Program (Health / Activity API), OAuth 1.0a.
//  Doc : https://developer.garmin.com  (clés via homologation partenaire).
//  Flux : request_token → autorisation → access_token → (push webhook | backfill).
//  Les endpoints/champs sont isolés ici ; le payload brut est conservé dans
//  external_activities.raw pour pouvoir affiner le mapping après homologation.
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { oauth1Header } from "./oauth1.ts";

export const GARMIN = {
  requestTokenUrl: "https://connectapi.garmin.com/oauth-service/oauth/request_token",
  authorizeUrl: "https://connect.garmin.com/oauthConfirm",
  accessTokenUrl: "https://connectapi.garmin.com/oauth-service/oauth/access_token",
  apiBase: "https://apis.garmin.com/wellness-api/rest",
  consumerKey: () => Deno.env.get("GARMIN_CONSUMER_KEY"),
  consumerSecret: () => Deno.env.get("GARMIN_CONSUMER_SECRET"),
  ready: () => !!Deno.env.get("GARMIN_CONSUMER_KEY"),
};

const ck = () => GARMIN.consumerKey()!;
const cs = () => GARMIN.consumerSecret()!;

/** Étape 1 : jeton de requête (oauth_callback). */
export async function garminRequestToken(callbackUrl: string): Promise<{ token: string; secret: string }> {
  const header = await oauth1Header({
    method: "POST", url: GARMIN.requestTokenUrl,
    consumerKey: ck(), consumerSecret: cs(),
    extraOauth: { oauth_callback: callbackUrl },
  });
  const res = await fetch(GARMIN.requestTokenUrl, { method: "POST", headers: { Authorization: header } });
  if (!res.ok) throw new Error(`Garmin request_token: ${res.status} ${await res.text()}`);
  const p = new URLSearchParams(await res.text());
  return { token: p.get("oauth_token")!, secret: p.get("oauth_token_secret")! };
}

/** Étape 3 : jeton d'accès (oauth_verifier reçu sur le callback). */
export async function garminAccessToken(reqToken: string, reqSecret: string, verifier: string) {
  const header = await oauth1Header({
    method: "POST", url: GARMIN.accessTokenUrl,
    consumerKey: ck(), consumerSecret: cs(),
    token: reqToken, tokenSecret: reqSecret,
    extraOauth: { oauth_verifier: verifier },
  });
  const res = await fetch(GARMIN.accessTokenUrl, { method: "POST", headers: { Authorization: header } });
  if (!res.ok) throw new Error(`Garmin access_token: ${res.status} ${await res.text()}`);
  const p = new URLSearchParams(await res.text());
  return { token: p.get("oauth_token")!, secret: p.get("oauth_token_secret")! };
}

/** GET signé OAuth1 (query params inclus dans la signature). */
export async function garminGet(url: string, token: string, secret: string, params: Record<string, string> = {}) {
  const header = await oauth1Header({
    method: "GET", url, consumerKey: ck(), consumerSecret: cs(),
    token, tokenSecret: secret, params,
  });
  const qs = new URLSearchParams(params).toString();
  return fetch(qs ? `${url}?${qs}` : url, { headers: { Authorization: header } });
}

/** Identifiant utilisateur Garmin (API user/id). */
export async function garminUserId(token: string, secret: string): Promise<string | null> {
  try {
    const res = await garminGet(`${GARMIN.apiBase}/user/id`, token, secret);
    if (!res.ok) return null;
    const j = await res.json();
    return j.userId ?? null;
  } catch { return null; }
}

/** Mappe un type d'activité Garmin vers une discipline. */
export function discFromGarmin(type: unknown): string | null {
  const t = String(type ?? "").toLowerCase();
  if (t.includes("swim")) return "swim";
  if (t.includes("cycl") || t.includes("bik")) return "bike";
  if (t.includes("run") || t.includes("walk") || t.includes("hik")) return "run";
  if (t.includes("strength") || t.includes("training") || t.includes("cardio") || t.includes("fitness")) return "strength";
  return null;
}

/** Activité Garmin (summary) → ligne external_activities. */
export function normalizeGarminActivity(a: any, userId: string) {
  const startSec = a.startTimeInSeconds ?? a.startTime;
  return {
    user_id: userId,
    provider: "garmin" as const,
    provider_activity_id: String(a.summaryId ?? a.activityId ?? a.id),
    disc: discFromGarmin(a.activityType ?? a.activityTypeDTO?.typeKey),
    name: a.activityName ?? a.activityType ?? null,
    start_time: startSec ? new Date(Number(startSec) * 1000).toISOString() : null,
    duration_s: a.durationInSeconds ?? a.duration ?? null,
    distance_m: a.distanceInMeters ?? a.distance ?? null,
    elevation_m: a.totalElevationGainInMeters ?? null,
    avg_hr: a.averageHeartRateInBeatsPerMinute ?? null,
    max_hr: a.maxHeartRateInBeatsPerMinute ?? null,
    avg_power: a.averagePowerInWatts ?? null,
    avg_speed: a.averageSpeedInMetersPerSecond ?? null,
    calories: a.activeKilocalories ?? a.calories ?? null,
    raw: a,
  };
}

export async function garminUpsertActivities(sb: SupabaseClient, list: any[], userId: string): Promise<number> {
  if (!Array.isArray(list) || list.length === 0) return 0;
  const rows = list.map((a) => normalizeGarminActivity(a, userId));
  const { error } = await sb.from("external_activities")
    .upsert(rows, { onConflict: "provider,provider_activity_id" });
  if (error) throw error;
  return rows.length;
}

/** Backfill best-effort des activités des 30 derniers jours. */
export async function garminImportRecent(sb: SupabaseClient, conn: any): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 30 * 24 * 3600;
  const res = await garminGet(`${GARMIN.apiBase}/activities`, conn.access_token, conn.token_secret, {
    uploadStartTimeInSeconds: String(start),
    uploadEndTimeInSeconds: String(now),
  });
  if (!res.ok) throw new Error(`Garmin activities: ${res.status} ${await res.text()}`);
  const list = await res.json();
  const n = await garminUpsertActivities(sb, Array.isArray(list) ? list : (list.activities ?? []), conn.user_id);
  await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
  return n;
}
