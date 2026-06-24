// =============================================================================
//  COROS Open API — OAuth2 + normalisation des activités.
//  Doc : https://open.coros.com  (accès partenaire requis pour les clés).
//  Le flux OAuth2 est calqué sur Strava ; les endpoints sont isolés ici pour
//  être ajustés facilement quand l'accès partenaire est obtenu.
//  Les noms de champs d'activité sont défensifs (fallbacks) et le payload brut
//  est toujours conservé dans external_activities.raw.
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const COROS = {
  authorizeUrl: "https://open.coros.com/oauth2/authorize",
  tokenUrl: "https://open.coros.com/oauth2/accesstoken",
  // Endpoint de liste d'activités (à confirmer selon la version d'API attribuée).
  activitiesUrl: "https://open.coros.com/v2/coros/sport/list",
  clientId: () => Deno.env.get("COROS_CLIENT_ID"),
  clientSecret: () => Deno.env.get("COROS_CLIENT_SECRET"),
  ready: () => !!Deno.env.get("COROS_CLIENT_ID"),
};

/** Mappe un type d'activité Coros (code numérique ou libellé) vers une discipline. */
export function discFromCoros(sport: unknown): string | null {
  const s = String(sport ?? "").toLowerCase();
  if (/swim|8|nat/.test(s)) return "swim";
  if (/bike|cycl|ride|^2|200/.test(s)) return "bike";
  if (/run|^1|100|trail/.test(s)) return "run";
  if (/strength|gym|muscu|train/.test(s)) return "strength";
  return null;
}

/** Activité Coros → ligne external_activities (défensif sur les noms de champs). */
export function normalizeCorosActivity(a: any, userId: string) {
  const id = a.labelId ?? a.activityId ?? a.id;
  const startSec = a.startTime ?? a.startTimestamp;
  return {
    user_id: userId,
    provider: "coros" as const,
    provider_activity_id: String(id),
    disc: discFromCoros(a.sportType ?? a.mode ?? a.sport),
    name: a.name ?? a.title ?? null,
    start_time: startSec ? new Date(Number(startSec) * (String(startSec).length > 12 ? 1 : 1000)).toISOString() : null,
    duration_s: a.totalTime ?? a.duration ?? a.workoutTime ?? null,
    distance_m: a.distance ?? a.totalDistance ?? null,
    elevation_m: a.elevGain ?? a.totalAscent ?? null,
    avg_hr: a.avgHeartRate ?? a.avgHr ?? null,
    max_hr: a.maxHeartRate ?? a.maxHr ?? null,
    avg_power: a.avgPower ?? null,
    avg_speed: a.avgSpeed ?? null,
    calories: a.calorie ?? a.calories ?? null,
    raw: a,
  };
}

/** Échange le code d'autorisation Coros contre des jetons. */
export async function corosExchangeCode(code: string, redirectUri: string): Promise<any> {
  const body = new URLSearchParams({
    client_id: COROS.clientId()!,
    client_secret: COROS.clientSecret()!,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(COROS.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Coros token: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Renvoie un access_token Coros valide (refresh si expiré). */
export async function corosValidToken(sb: SupabaseClient, conn: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = conn.expires_at ? Math.floor(new Date(conn.expires_at).getTime() / 1000) : 0;
  if (conn.access_token && exp - 60 > now) return conn.access_token;

  const body = new URLSearchParams({
    client_id: COROS.clientId()!,
    client_secret: COROS.clientSecret()!,
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
  });
  const res = await fetch(COROS.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Coros refresh: ${res.status} ${await res.text()}`);
  const t = await res.json();
  const expiresAt = t.expires_in ? new Date((now + Number(t.expires_in)) * 1000).toISOString() : null;
  await sb.from("device_connections").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? conn.refresh_token,
    expires_at: expiresAt,
  }).eq("id", conn.id);
  return t.access_token;
}

/** Upsert une liste d'activités Coros déjà reçues (depuis le webhook ou un pull). */
export async function corosUpsertActivities(sb: SupabaseClient, list: any[], userId: string): Promise<number> {
  if (!Array.isArray(list) || list.length === 0) return 0;
  const rows = list.map((a) => normalizeCorosActivity(a, userId));
  const { error } = await sb.from("external_activities")
    .upsert(rows, { onConflict: "provider,provider_activity_id" });
  if (error) throw error;
  return rows.length;
}

/** Pull best-effort des activités récentes Coros. */
export async function corosImportRecent(sb: SupabaseClient, conn: any): Promise<number> {
  const token = await corosValidToken(sb, conn);
  const url = `${COROS.activitiesUrl}?token=${encodeURIComponent(token)}&openId=${encodeURIComponent(conn.provider_user_id ?? "")}&size=30`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Coros activities: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const list = data?.data?.dataList ?? data?.data ?? data?.dataList ?? [];
  const n = await corosUpsertActivities(sb, list, conn.user_id);
  await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
  return n;
}
