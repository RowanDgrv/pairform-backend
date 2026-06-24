// =============================================================================
//  Lib partagée — intégrations objets connectés (Strava / Garmin / Coros …)
//  ---------------------------------------------------------------------------
//  Centralise : config OAuth de chaque plateforme, normalisation des activités
//  vers les disciplines de l'app, et le rafraîchissement des jetons.
//
//  ÉTAT :
//   • Strava  → entièrement implémenté (API publique, inscription immédiate).
//   • Garmin  → OAuth/endpoints renseignés mais nécessitent l'homologation
//               "Garmin Connect Developer Program" (clés partenaire).
//   • Coros   → OAuth2 renseigné, nécessite le "COROS Open API" partner program.
// =============================================================================
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export type Provider = "strava" | "garmin" | "coros" | "polar" | "suunto" | "wahoo";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function appUrl(): string {
  return Deno.env.get("APP_URL") ?? "http://localhost:5500";
}

/** URL publique des edge functions (base des redirect_uri OAuth). */
export function functionsBase(): string {
  // SUPABASE_URL = https://xxxx.supabase.co  →  .../functions/v1
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
}

// -----------------------------------------------------------------------------
//  Config OAuth par plateforme
// -----------------------------------------------------------------------------
interface OAuthConfig {
  ready: boolean;                 // false = en attente de clés/homologation
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId(): string | undefined;
  clientSecret(): string | undefined;
}

export const OAUTH: Record<string, OAuthConfig> = {
  strava: {
    ready: true,
    authorizeUrl: "https://www.strava.com/oauth/authorize",
    tokenUrl: "https://www.strava.com/oauth/token",
    scope: "read,activity:read_all",
    clientId: () => Deno.env.get("STRAVA_CLIENT_ID"),
    clientSecret: () => Deno.env.get("STRAVA_CLIENT_SECRET"),
  },
  // Garmin Activity/Health API : OAuth1.0a — branché après homologation.
  garmin: {
    ready: false,
    authorizeUrl: "https://connect.garmin.com/oauthConfirm",
    tokenUrl: "https://connectapi.garmin.com/oauth-service/oauth/access_token",
    scope: "",
    clientId: () => Deno.env.get("GARMIN_CONSUMER_KEY"),
    clientSecret: () => Deno.env.get("GARMIN_CONSUMER_SECRET"),
  },
  // COROS Open API : OAuth2 — branché après accès partenaire.
  coros: {
    ready: false,
    authorizeUrl: "https://open.coros.com/oauth2/authorize",
    tokenUrl: "https://open.coros.com/oauth2/accesstoken",
    scope: "",
    clientId: () => Deno.env.get("COROS_CLIENT_ID"),
    clientSecret: () => Deno.env.get("COROS_CLIENT_SECRET"),
  },
};

// -----------------------------------------------------------------------------
//  Normalisation des activités → forme `external_activities`
// -----------------------------------------------------------------------------
/** Mappe un type Strava vers une discipline de l'app. */
export function discFromStrava(type: string): string | null {
  const t = (type || "").toLowerCase();
  if (t.includes("swim")) return "swim";
  if (t.includes("ride") || t.includes("cycl") || t.includes("bike") || t.includes("velomobile")) return "bike";
  if (t.includes("run") || t.includes("walk") || t.includes("hike")) return "run";
  if (t.includes("weight") || t.includes("workout") || t.includes("crossfit") || t.includes("hiit") || t.includes("training")) return "strength";
  return null;
}

/** Active de l'API Strava → ligne `external_activities`. */
export function normalizeStravaActivity(a: any, userId: string) {
  return {
    user_id: userId,
    provider: "strava" as Provider,
    provider_activity_id: String(a.id),
    disc: discFromStrava(a.sport_type || a.type || ""),
    name: a.name ?? null,
    start_time: a.start_date ?? null,
    duration_s: a.moving_time ?? a.elapsed_time ?? null,
    distance_m: a.distance ?? null,
    elevation_m: a.total_elevation_gain ?? null,
    avg_hr: a.average_heartrate ?? null,
    max_hr: a.max_heartrate ?? null,
    avg_power: a.average_watts ?? null,
    avg_speed: a.average_speed ?? null,
    calories: a.calories ?? a.kilojoules ?? null,
    raw: a,
  };
}

// -----------------------------------------------------------------------------
//  Jetons Strava
// -----------------------------------------------------------------------------
export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
}

/** Échange un code d'autorisation Strava contre des jetons. */
export async function stravaExchangeCode(code: string): Promise<any> {
  const res = await fetch(OAUTH.strava.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH.strava.clientId(),
      client_secret: OAUTH.strava.clientSecret(),
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Strava token exchange: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Renvoie un access_token Strava valide pour une connexion, en rafraîchissant
 *  si besoin et en persistant les nouveaux jetons. */
export async function stravaValidToken(sb: SupabaseClient, conn: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = conn.expires_at ? Math.floor(new Date(conn.expires_at).getTime() / 1000) : 0;
  if (conn.access_token && exp - 60 > now) return conn.access_token;

  const res = await fetch(OAUTH.strava.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH.strava.clientId(),
      client_secret: OAUTH.strava.clientSecret(),
      grant_type: "refresh_token",
      refresh_token: conn.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Strava refresh: ${res.status} ${await res.text()}`);
  const t = await res.json();
  await sb.from("device_connections").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
  }).eq("id", conn.id);
  return t.access_token;
}

/** Importe les N dernières activités Strava d'une connexion. Renvoie le nombre. */
export async function stravaImportRecent(sb: SupabaseClient, conn: any, perPage = 30): Promise<number> {
  const token = await stravaValidToken(sb, conn);
  const res = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Strava activities: ${res.status} ${await res.text()}`);
  const acts = await res.json();
  if (!Array.isArray(acts) || acts.length === 0) return 0;
  const rows = acts.map((a) => normalizeStravaActivity(a, conn.user_id));
  const { error } = await sb.from("external_activities")
    .upsert(rows, { onConflict: "provider,provider_activity_id" });
  if (error) throw error;
  await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
  return rows.length;
}

/** Récupère l'utilisateur courant à partir du header Authorization (JWT). */
export async function userFromReq(sb: SupabaseClient, req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const { data } = await sb.auth.getUser(authHeader.replace("Bearer ", ""));
  return data.user ?? null;
}

/** State OAuth aléatoire (URL-safe). */
export function randomState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
}
