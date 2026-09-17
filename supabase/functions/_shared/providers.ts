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
//   • Coros   → migré vers le serveur MCP self-service : voir _shared/corosMcp.ts
//               (OAuth 2.1 + PKCE + enregistrement dynamique, sans homologation).
//               L'entrée OAUTH.coros ci-dessous est CONSERVÉE mais neutralisée
//               (ready:false) — device-connect court-circuite vers corosMcp.
// =============================================================================
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptToken } from "./tokenCrypto.ts";

export type Provider = "strava" | "garmin" | "coros" | "polar" | "suunto" | "wahoo";

// Origine autorisée pilotée par env (durci — voir _shared/cors.ts). Une seule
// origine explicite, jamais '*'. Défaut = front GitHub Pages ; en prod, poser
// CORS_ORIGIN sur le domaine réel.
const ALLOWED_ORIGIN = Deno.env.get("CORS_ORIGIN") ?? "https://rowandgrv.github.io";
export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
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
  // COROS : NE PAS utiliser cette entrée — la connexion passe par le serveur
  // MCP self-service (_shared/corosMcp.ts), court-circuité dans device-connect.
  // Neutralisée ici pour qu'aucun autre chemin ne rappelle l'ancienne Open API.
  coros: {
    ready: false,
    authorizeUrl: "https://mcpeu.coros.com/oauth2/authorize",
    tokenUrl: "https://mcpeu.coros.com/oauth2/token",
    scope: "openid mcp.tools offline_access",
    clientId: () => undefined,
    clientSecret: () => undefined,
  },
  // Polar AccessLink : API publique, inscription self-service immédiate sur
  // admin.polaraccesslink.com (contrairement à Garmin) — remplace Garmin
  // comme 3e connecteur en attendant que le programme Garmin rouvre.
  // Jeton d'échange = Basic auth (pas JSON) → géré par polarExchangeCode ci-dessous,
  // pas par le flux générique utilisé pour Strava.
  // Client "V4" (auth.polar.com — confirmé par la doc officielle
  // https://www.polar.com/polar-api-v4/). Le scope N'EST PAS optionnel en V4 :
  // c'est une liste de permissions "resource:read" séparées par des espaces
  // (ex. training_sessions:read), à ne pas confondre avec l'ancien scope V3
  // "accesslink.read_all" (qui échoue) ni avec une absence de scope (qui
  // échoue aussi — bug des deux tentatives précédentes, corrigé le 17/09).
  polar: {
    ready: true,
    authorizeUrl: "https://auth.polar.com/oauth/authorize",
    tokenUrl: "https://auth.polar.com/oauth/token",
    scope: "training_sessions:read",
    clientId: () => Deno.env.get("POLAR_CLIENT_ID"),
    clientSecret: () => Deno.env.get("POLAR_CLIENT_SECRET"),
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
    access_token: await encryptToken(t.access_token),
    refresh_token: await encryptToken(t.refresh_token),
    expires_at: new Date(t.expires_at * 1000).toISOString(),
  }).eq("id", conn.id);
  return t.access_token;
}

/** Détail d'une activité Strava (laps, start_date…). */
export async function stravaFetchActivityDetail(token: string, activityId: string): Promise<any> {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava activity detail: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Séries temporelles brutes d'une activité Strava (GPS/FC/allure/puissance point par point). */
export async function stravaFetchStreams(token: string, activityId: string): Promise<any> {
  const keys = "time,latlng,distance,altitude,velocity_smooth,heartrate,cadence,watts";
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=${keys}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Strava streams: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Zippe les séries parallèles Strava (`key_by_type`) en points `{time,lat,lon,alt,
 *  distM,hr,cad,pw,spdMs,stepLen}` — même forme que le parseur .FIT (sillance-fit.js),
 *  pour rejouer TEL QUEL le même modal d'analyse (découplage, IA, comparateur…). */
export function normalizeStravaStreams(detail: any, streams: any, disc: string | null) {
  const t0 = new Date(detail?.start_date ?? detail?.start_date_local ?? Date.now()).getTime();
  const time = streams?.time?.data ?? [];
  const latlng = streams?.latlng?.data ?? [];
  const dist = streams?.distance?.data ?? [];
  const alt = streams?.altitude?.data ?? [];
  const vel = streams?.velocity_smooth?.data ?? [];
  const hr = streams?.heartrate?.data ?? [];
  const cadRaw = streams?.cadence?.data ?? [];
  const watts = streams?.watts?.data ?? [];
  // Convention connue de l'API Strava : la cadence course est comptée sur UNE
  // jambe (pas/min d'un pied) — on double pour retomber sur le pas/min total
  // attendu par l'app (même unité que les montres). Le vélo reste en rpm brut.
  const cadMul = disc === "run" ? 2 : 1;
  const n = time.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      time: t0 + (time[i] ?? 0) * 1000,
      lat: latlng[i]?.[0] ?? null,
      lon: latlng[i]?.[1] ?? null,
      alt: alt[i] ?? null,
      distM: dist[i] ?? null,
      hr: hr[i] ?? 0,
      cad: cadRaw[i] != null ? Math.round(cadRaw[i] * cadMul) : 0,
      pw: watts[i] ?? 0,
      spdMs: vel[i] ?? null,
      stepLen: null,
    });
  }
  return pts;
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

// -----------------------------------------------------------------------------
//  Polar AccessLink (client "V4", auth.polar.com — voir OAUTH.polar)
//  ---------------------------------------------------------------------------
//  Particularités vs Strava : échange de code en Basic Auth (pas JSON).
//  Jeton d'accès valable 12 h + refresh_token fourni (contrairement à V3) →
//  polarValidToken() rafraîchit avant chaque sync, comme pour Strava.
//  L'enregistrement explicite POST /v3/users (obligatoire en V3) n'existe
//  plus documenté en V4 — appel laissé en best-effort (voir polarRegisterUser).
//  ⚠️ Chemin/format exact des endpoints de données V4 non confirmé à 100% par
//  une vraie réponse ; polarImportRecent journalise le JSON brut au premier
//  échec de mapping pour ajuster vite si les noms de champs diffèrent.
// -----------------------------------------------------------------------------
const POLAR_API_V3 = "https://www.polaraccesslink.com/v3";     // register user (best-effort)
const POLAR_API_V4 = "https://www.polaraccesslink.com/v4/data"; // exercices/activité

/** Mappe un sport Polar vers une discipline de l'app. */
export function discFromPolar(sport: string): string | null {
  const t = (sport || "").toLowerCase();
  if (t.includes("swim")) return "swim";
  if (t.includes("cycl") || t.includes("bik")) return "bike";
  if (t.includes("run") || t.includes("walk") || t.includes("hik")) return "run";
  if (t.includes("strength") || t.includes("fitness") || t.includes("cross")) return "strength";
  return null;
}

/** Convertit une durée ISO 8601 Polar ("PT2H44M30S") en secondes. */
function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const [, h, min, s] = m;
  return (Number(h || 0) * 3600) + (Number(min || 0) * 60) + Number(s || 0);
}

/** Échange un code d'autorisation Polar contre des jetons (Basic Auth). */
export async function polarExchangeCode(code: string, redirectUri: string): Promise<any> {
  const basic = btoa(`${OAUTH.polar.clientId()}:${OAUTH.polar.clientSecret()}`);
  const res = await fetch(OAUTH.polar.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`Polar token exchange: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Enregistre l'utilisateur côté Polar. Best-effort : ce endpoint est
 *  documenté pour V3 seulement ; en V4 il peut renvoyer 404, ce qui est
 *  silencieusement ignoré (n'importe pas pour la suite). */
export async function polarRegisterUser(accessToken: string, memberId: string): Promise<void> {
  const res = await fetch(`${POLAR_API_V3}/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ "member-id": memberId }),
  });
  // 409 = déjà enregistré, 404 = endpoint absent en V4 — ni l'un ni l'autre n'est bloquant.
  if (!res.ok && res.status !== 409 && res.status !== 404) {
    console.error(`Polar register user: ${res.status} ${await res.text()}`);
  }
}

/** Renvoie un access_token Polar valide, en rafraîchissant si besoin (jetons
 *  V4 valables 12 h) et en persistant les nouveaux jetons. */
export async function polarValidToken(sb: SupabaseClient, conn: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = conn.expires_at ? Math.floor(new Date(conn.expires_at).getTime() / 1000) : 0;
  if (conn.access_token && exp - 60 > now) return conn.access_token;
  if (!conn.refresh_token) return conn.access_token; // pas de refresh dispo, on tente tel quel

  const basic = btoa(`${OAUTH.polar.clientId()}:${OAUTH.polar.clientSecret()}`);
  const res = await fetch(OAUTH.polar.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh_token }),
  });
  if (!res.ok) throw new Error(`Polar refresh: ${res.status} ${await res.text()}`);
  const t = await res.json();
  await sb.from("device_connections").update({
    access_token: await encryptToken(t.access_token),
    refresh_token: await encryptToken(t.refresh_token ?? conn.refresh_token),
    expires_at: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : null,
  }).eq("id", conn.id);
  return t.access_token;
}

/** Active de l'API Polar → ligne `external_activities`. Tolérant aux variantes
 *  de nommage (snake_case / kebab-case) tant que le format exact V4 n'a pas
 *  été observé sur une vraie réponse. */
function normalizePolarActivity(a: any, userId: string) {
  const id = a.id ?? a["exercise-id"] ?? a.exerciseId ?? a["training-session-id"];
  const sportObj = a.sport ?? {};
  const sport = (typeof sportObj === "string" ? sportObj : sportObj.name) ??
    a["detailed-sport-info"] ?? a.type ?? "";
  const hr = a["heart-rate"] ?? a.heart_rate ?? {};
  return {
    user_id: userId,
    provider: "polar" as Provider,
    provider_activity_id: String(id),
    disc: discFromPolar(sport),
    name: sport || null,
    start_time: a.startTime ?? a.start_time ?? a["start-time"] ?? null,
    duration_s: parseIsoDuration(a.duration),
    distance_m: a.distance ?? null,
    elevation_m: null,
    avg_hr: hr.average ?? a["heart-rate-average"] ?? null,
    max_hr: hr.maximum ?? a["heart-rate-maximum"] ?? null,
    avg_power: null,
    avg_speed: null,
    calories: a.calories ?? null,
    raw: a,
  };
}

/** Importe les activités Polar récentes. Endpoint/format V4 pas confirmé par
 *  une vraie réponse : journalise le JSON brut si le mapping tombe à 0 ligne
 *  malgré une liste non vide, pour ajuster vite sans deviner davantage. */
export async function polarImportRecent(sb: SupabaseClient, conn: any): Promise<number> {
  const token = await polarValidToken(sb, conn);
  const res = await fetch(`${POLAR_API_V4}/training-sessions/list`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Polar training-sessions: ${res.status} ${await res.text()}`);
  const acts = await res.json();
  const list = Array.isArray(acts) ? acts : (acts?.data ?? acts?.["training-sessions"] ?? acts?.exercises ?? []);
  if (!list.length) return 0;
  const rows = list.map((a: any) => normalizePolarActivity(a, conn.user_id));
  if (rows.some((r) => r.provider_activity_id === "undefined")) {
    console.error("Polar: format de réponse inattendu, réponse brute :", JSON.stringify(acts).slice(0, 2000));
  }
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
