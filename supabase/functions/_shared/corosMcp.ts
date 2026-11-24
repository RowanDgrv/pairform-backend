// =============================================================================
//  _shared/corosMcp.ts
//  ---------------------------------------------------------------------------
//  COROS via son serveur MCP hébergé (self-service, sans homologation).
//
//    Serveur MCP      : https://mcpeu.coros.com/mcp   (zone EU ; override COROS_MCP_BASE)
//    Serveur OAuth 2.1: https://mcpeu.coros.com/oauth2/{authorize,token}
//    Enregistrement   : https://mcpeu.coros.com/connect/register   (RFC 7591 — aucun dossier)
//    Scopes           : openid mcp.tools offline_access
//    PKCE             : S256 obligatoire
//
//  Modèle : un athlète connecte SON compte COROS (OAuth navigateur). Sillance
//  stocke ses jetons dans device_connections et appelle le serveur MCP en son
//  nom, côté serveur, sur planning (coros-poll) — pas de webhook en self-service.
//
//  Les sorties des tools MCP sont du TEXTE formaté pour un LLM. On lit d'abord
//  `structuredContent` si présent, sinon on parse le texte de façon défensive
//  et on conserve toujours le brut dans external_activities.raw.
//
//  ÉCRITURE (pousser une séance planifiée vers la montre) : disponible en
//  vrai depuis le 29/09/2026 (createScheduledWorkout vérifié en direct) —
//  voir pushPlannedSession plus bas + _shared/corosSessionMap.ts pour la
//  traduction du format de séance Sillance vers le format COROS.
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptToken } from "./tokenCrypto.ts";
import { AthleteRef, SillanceSessionForPush, sessionToCorosCourse } from "./corosSessionMap.ts";

// -----------------------------------------------------------------------------
//  Config
// -----------------------------------------------------------------------------
const BASE = (Deno.env.get("COROS_MCP_BASE") ?? "https://mcpeu.coros.com").replace(/\/+$/, "");
export const COROS_MCP = {
  base: BASE,
  mcpUrl: `${BASE}/mcp`,
  authorizeUrl: `${BASE}/oauth2/authorize`,
  tokenUrl: `${BASE}/oauth2/token`,
  registerUrl: `${BASE}/connect/register`,
  resource: BASE, // RFC 8707 — la ressource protégée (metadata `resource`)
  scope: "openid mcp.tools offline_access",
  protocolVersion: "2025-06-18",
  ready: () => true, // self-service : toujours prêt (le client s'enregistre seul)
};

// -----------------------------------------------------------------------------
//  Enregistrement dynamique de client (persistant en base)
// -----------------------------------------------------------------------------
/** client_id COROS : lu depuis integration_oauth_clients, enregistré si absent. */
export async function corosClientId(sb: SupabaseClient, redirectUri: string): Promise<string> {
  const { data: row } = await sb.from("integration_oauth_clients")
    .select("client_id").eq("provider", "coros").maybeSingle();
  if (row?.client_id) return row.client_id;

  // Priorité à un client_id posé en secret (si Rowan préfère le figer).
  const fixed = Deno.env.get("COROS_MCP_CLIENT_ID");
  if (fixed) {
    await sb.from("integration_oauth_clients").upsert({
      provider: "coros", client_id: fixed, registration: { source: "env" },
    }, { onConflict: "provider" });
    return fixed;
  }

  const res = await fetch(COROS_MCP.registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Sillance",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: COROS_MCP.scope,
    }),
  });
  if (!res.ok) throw new Error(`COROS DCR: ${res.status} ${await res.text()}`);
  const reg = await res.json();
  await sb.from("integration_oauth_clients").upsert({
    provider: "coros",
    client_id: reg.client_id,
    client_secret: reg.client_secret ?? null,
    registration: reg,
  }, { onConflict: "provider" });
  return reg.client_id as string;
}

// -----------------------------------------------------------------------------
//  PKCE
// -----------------------------------------------------------------------------
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function pkceVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

// -----------------------------------------------------------------------------
//  Flux OAuth
// -----------------------------------------------------------------------------
/** Construit l'URL d'autorisation COROS. Range le code_verifier dans oauth_states.meta. */
export async function buildAuthUrl(sb: SupabaseClient, userId: string, redirectUri: string): Promise<string> {
  const clientId = await corosClientId(sb, redirectUri);
  const verifier = pkceVerifier();
  const challenge = await pkceChallenge(verifier);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));

  const { error } = await sb.from("oauth_states").insert({
    state, user_id: userId, provider: "coros",
    meta: { code_verifier: verifier, redirect_uri: redirectUri },
  });
  if (error) throw error;

  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: COROS_MCP.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: COROS_MCP.resource,
  });
  return `${COROS_MCP.authorizeUrl}?${p.toString()}`;
}

interface TokenResp {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Échange le code d'autorisation contre des jetons (client public + PKCE). */
export async function exchangeCode(
  clientId: string, code: string, verifier: string, redirectUri: string,
): Promise<TokenResp> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: COROS_MCP.resource,
  });
  const res = await fetch(COROS_MCP.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`COROS token: ${res.status} ${await res.text()}`);
  return res.json();
}

/** access_token valide pour une connexion (refresh si expiré, persiste). */
export async function validToken(sb: SupabaseClient, conn: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = conn.expires_at ? Math.floor(new Date(conn.expires_at).getTime() / 1000) : 0;
  // Renouvellement ANTICIPÉ : COROS refuse le refresh_token (400 invalid_grant) une fois les
  // 30 jours du jeton d'accès écoulés (constaté le 24/11/2026 sur 2 comptes, morts pile à
  // l'expiration). On renouvelle donc dès qu'il reste moins de 7 jours, tant que c'est possible.
  const REFRESH_AHEAD_S = 7 * 24 * 3600;
  if (conn.access_token && exp - REFRESH_AHEAD_S > now) return conn.access_token;
  if (conn.access_token && exp - 120 > now && !conn.refresh_token) return conn.access_token;
  if (!conn.refresh_token) throw new Error("COROS: pas de refresh_token — reconnexion requise");

  const redirectUri = conn.meta?.redirect_uri
    ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/coros-oauth-callback`;
  const clientId = await corosClientId(sb, redirectUri);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
    client_id: clientId,
    resource: COROS_MCP.resource,
  });
  const res = await fetch(COROS_MCP.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const err = `COROS refresh: ${res.status} ${await res.text()}`;
    // Renouvellement anticipé raté (réseau, appel concurrent…) : le jeton actuel est encore
    // valable, on continue avec lui ; on retentera au prochain passage (toutes les ~2 h).
    if (conn.access_token && exp - 120 > now) { console.warn(err, "→ jeton actuel conservé"); return conn.access_token; }
    throw new Error(err);
  }
  const t: TokenResp = await res.json();
  const expiresAt = t.expires_in ? new Date((now + Number(t.expires_in)) * 1000).toISOString() : null;
  await sb.from("device_connections").update({
    access_token: await encryptToken(t.access_token),
    refresh_token: await encryptToken(t.refresh_token ?? conn.refresh_token),
    expires_at: expiresAt,
    scope: t.scope ?? conn.scope,
  }).eq("id", conn.id);
  return t.access_token;
}

// -----------------------------------------------------------------------------
//  Client MCP minimal (Streamable HTTP / JSON-RPC 2.0)
//  On ne fait qu'initialize + tools/call. Réponse JSON ou SSE : les deux gérées.
// -----------------------------------------------------------------------------
interface McpResult { structured: any; text: string; }

async function rpc(token: string, sessionId: string | null, payload: unknown): Promise<{ body: any; sessionId: string | null }> {
  const res = await fetch(COROS_MCP.mcpUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": COROS_MCP.protocolVersion,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  const newSession = res.headers.get("Mcp-Session-Id") ?? sessionId;
  if (!res.ok) throw new Error(`MCP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const ct = res.headers.get("Content-Type") ?? "";
  const raw = await res.text();
  if (!raw.trim()) return { body: null, sessionId: newSession };

  if (ct.includes("text/event-stream")) {
    // Concatène les data: des évènements SSE, garde le dernier objet JSON-RPC
    // porteur d'un `result` ou `error`.
    let last: any = null;
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[1]);
        if (obj && (obj.result !== undefined || obj.error !== undefined || obj.method)) last = obj;
      } catch { /* fragment partiel : ignore */ }
    }
    return { body: last, sessionId: newSession };
  }
  return { body: JSON.parse(raw), sessionId: newSession };
}

/** Ouvre une session, appelle un tool, renvoie { structured, text }. */
export async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}): Promise<McpResult> {
  // 1. initialize
  const init = await rpc(token, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: COROS_MCP.protocolVersion,
      capabilities: {},
      clientInfo: { name: "sillance", version: "1.0" },
    },
  });
  const session = init.sessionId;
  if (init.body?.error) throw new Error(`MCP initialize: ${JSON.stringify(init.body.error)}`);

  // 2. notifications/initialized (best-effort)
  try {
    await rpc(token, session, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  } catch { /* certains serveurs stateless n'en veulent pas */ }

  // 3. tools/call
  const call = await rpc(token, session, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name, arguments: args },
  });
  if (call.body?.error) throw new Error(`MCP ${name}: ${JSON.stringify(call.body.error)}`);
  const result = call.body?.result ?? {};
  const text = Array.isArray(result.content)
    ? result.content.filter((c: any) => c?.type === "text").map((c: any) => unwrapJsonString(c.text)).join("\n")
    : "";
  return { structured: result.structuredContent ?? null, text };
}

/**
 * Certains tools COROS renvoient leur texte DÉJÀ encodé en JSON (guillemets +
 * "\n" littéraux) — d'autres non (spike 07/09 : querySportRecords/querySleepHrv
 * doublement encodés, queryActivityFitFileDownloadUrls non). On déballe si
 * besoin pour que les parsers travaillent sur de vrais retours à la ligne.
 */
function unwrapJsonString(s: unknown): string {
  if (typeof s !== "string") return String(s ?? "");
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && (t.includes("\\n") || t.includes('\\"'))) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch { /* pas du JSON valide : on garde tel quel */ }
  }
  return s;
}

/** Liste les tools exposés (pour savoir si l'écriture est disponible). */
export async function mcpListTools(token: string): Promise<string[]> {
  const init = await rpc(token, null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: COROS_MCP.protocolVersion, capabilities: {}, clientInfo: { name: "sillance", version: "1.0" } },
  });
  const list = await rpc(token, init.sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = list.body?.result?.tools ?? [];
  return tools.map((t: any) => t?.name).filter(Boolean);
}

// -----------------------------------------------------------------------------
//  Mapping discipline (codes sport COROS "dubbo")
// -----------------------------------------------------------------------------
export function discFromCorosCode(code: unknown): string | null {
  const c = Number(code);
  if (c >= 100 && c <= 106) return "run";         // outdoor/indoor/trail/track run, hike, climb
  if (c === 900 || c === 902) return "run";        // walk, stair climbing
  if ((c >= 200 && c <= 205) || c === 299) return "bike";
  if (c === 300 || c === 301) return "swim";
  if (c >= 400 && c <= 402) return "strength";     // gym cardio, GPS cardio, strength
  if (c === 901 || (c >= 904 && c <= 906) || (c >= 9900 && c <= 9904)) return "strength"; // jump rope, yoga, pilates, boxing, indoor custom
  if (c === 1200) return "hyrox";                  // hybrid fitness
  if (c >= 10000 && c <= 10003) return "tri";      // triathlon / multisport
  return null;
}

// -----------------------------------------------------------------------------
//  Parse de querySportRecords (texte LLM) → activités
//  Format observé (07/09/2026) :
//    1. Outdoor Run — 2026-09-06
//       Location: Paris Course
//       Time Window: startTimestamp=1788689506 | endTimestamp=1788693766
//       Duration: 1:10:01 | Distance: 13.02 km
//       Average Pace: 5:23 /km | Avg HR: 123 bpm | Calories: 855 kcal
//       LabelId: 480150172735668227 | SportType: 100
// -----------------------------------------------------------------------------
export interface CorosActivity {
  labelId: string;
  sportType: number | null;
  name: string | null;
  date: string | null;
  startTs: number | null;
  endTs: number | null;
  durationS: number | null;
  distanceM: number | null;
  avgHr: number | null;
  calories: number | null;
  avgSpeed: number | null;
}

function hmsToSeconds(s: string): number | null {
  const parts = s.trim().split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function parseSportRecords(text: string): CorosActivity[] {
  const out: CorosActivity[] = [];
  // Découpe par entrée numérotée « \n1. … »
  const blocks = text.split(/\n(?=\s*\d+\.\s)/);
  for (const block of blocks) {
    const label = block.match(/LabelId:\s*(\d+)/i);
    if (!label) continue;
    const head = block.match(/^\s*\d+\.\s*(.+?)\s+[—–-]\s*(\d{4}-\d{2}-\d{2})/m);
    const sport = block.match(/SportType:\s*(\d+)/i);
    const win = block.match(/startTimestamp=(\d+)\s*\|\s*endTimestamp=(\d+)/i);
    const dur = block.match(/Duration:\s*([\d:]+)/i);
    const dist = block.match(/Distance:\s*([\d.]+)\s*km/i);
    const hr = block.match(/Avg HR:\s*(\d+)/i);
    const kcal = block.match(/Calories:\s*(\d+)/i);
    const spd = block.match(/Average Speed:\s*([\d.]+)\s*km\/h/i);

    out.push({
      labelId: label[1],
      sportType: sport ? Number(sport[1]) : null,
      name: head ? head[1].trim() : null,
      date: head ? head[2] : null,
      startTs: win ? Number(win[1]) : null,
      endTs: win ? Number(win[2]) : null,
      durationS: dur ? hmsToSeconds(dur[1]) : null,
      distanceM: dist ? Math.round(parseFloat(dist[1]) * 1000) : null,
      avgHr: hr ? Number(hr[1]) : null,
      calories: kcal ? Number(kcal[1]) : null,
      avgSpeed: spd ? +(parseFloat(spd[1]) / 3.6).toFixed(3) : null,
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
//  Import des activités récentes
// -----------------------------------------------------------------------------
function normalizeCoros(a: CorosActivity, userId: string, fitUrl: string | null) {
  return {
    user_id: userId,
    provider: "coros" as const,
    provider_activity_id: a.labelId,
    disc: discFromCorosCode(a.sportType),
    name: a.name,
    start_time: a.startTs ? new Date(a.startTs * 1000).toISOString() : (a.date ? `${a.date}T00:00:00Z` : null),
    duration_s: a.durationS,
    distance_m: a.distanceM,
    elevation_m: null,
    avg_hr: a.avgHr,
    max_hr: null,
    avg_power: null,
    avg_speed: a.avgSpeed,
    calories: a.calories,
    raw: { ...a, fit_url: fitUrl, source: "coros-mcp" },
  };
}

/** yyyyMMdd il y a N jours / aujourd'hui. */
function ymd(daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Importe les activités COROS des `days` derniers jours dans external_activities.
 * `withFit` : nombre max de fichiers .FIT à résoudre cette passe (quota COROS
 * = 50 .fit/jour/compte) — l'URL est stockée dans raw.fit_url pour parse ultérieur.
 */
export async function importRecent(sb: SupabaseClient, conn: any, days = 21, withFit = 15): Promise<number> {
  const token = await validToken(sb, conn);

  const { text } = await mcpCall(token, "querySportRecords", {
    startDate: ymd(days),
    endDate: ymd(0),
    sportTypeCodes: [65535],
    limit: 50,
  });
  const acts = parseSportRecords(text);
  if (acts.length === 0) {
    await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
    return 0;
  }

  // Quelles activités sont déjà en base (évite de brûler le quota .FIT) ?
  const ids = acts.map((a) => a.labelId);
  const { data: known } = await sb.from("external_activities")
    .select("provider_activity_id, raw")
    .eq("provider", "coros").in("provider_activity_id", ids);
  const knownMap = new Map((known ?? []).map((r: any) => [r.provider_activity_id, r]));

  let fitBudget = withFit;
  const rows = [];
  for (const a of acts) {
    const existing = knownMap.get(a.labelId);
    let fitUrl: string | null = existing?.raw?.fit_url ?? null;
    if (!fitUrl && fitBudget > 0 && a.sportType != null) {
      try {
        const { text: ft } = await mcpCall(token, "queryActivityFitFileDownloadUrls", {
          labelId: a.labelId, sportType: a.sportType,
        });
        const u = ft.match(/https?:\/\/\S+\.fit/i);
        if (u) { fitUrl = u[0]; fitBudget--; }
      } catch (e) { console.warn("coros fit url:", a.labelId, String(e).slice(0, 120)); }
    }
    rows.push(normalizeCoros(a, conn.user_id, fitUrl));
  }

  const { error } = await sb.from("external_activities")
    .upsert(rows, { onConflict: "provider,provider_activity_id" });
  if (error) throw error;
  await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
  return rows.length;
}

// -----------------------------------------------------------------------------
//  Bilan "état de forme" — VFC sommeil + récupération + charge
//  Rangé dans device_connections.meta.wellness (exposé via my_devices) et,
//  si un check-in existe pour aujourd'hui, on renseigne checkins.hrv.
// -----------------------------------------------------------------------------
export async function fetchWellness(sb: SupabaseClient, conn: any): Promise<Record<string, unknown>> {
  const token = await validToken(sb, conn);
  const wellness: Record<string, unknown> = { at: new Date().toISOString() };

  try {
    const { text } = await mcpCall(token, "querySleepHrv", { startDate: ymd(2), endDate: ymd(0), days: 3 });
    // "2026-09-06:  HRV Avg: 95 ms — Normal  Normal Range: 57 - 117 ms  Baseline: 87 ms"
    // 19/11/2026 : COROS met désormais la date et chaque valeur sur des lignes séparées
    // (l'ancien motif sur une ligne ne trouvait plus rien) → parseur commun, nuit la plus récente.
    const days = parseSleepHrv(text), last = Object.keys(days).sort().pop();
    if (last) {
      const h = days[last] as any;
      wellness.hrv = { date: last, avgMs: h.hrv_ms, evaluation: h.hrv_eval, normalLow: h.hrv_low, normalHigh: h.hrv_high, baselineMs: h.hrv_baseline };
    }
  } catch (e) { console.warn("coros hrv:", String(e).slice(0, 120)); }

  try {
    const { text } = await mcpCall(token, "queryRecoveryStatus", {});
    const pct = text.match(/Recovery:\s*(\d+)\s*%/i);
    const lvl = text.match(/Level:\s*([^\r\n]+)/i);
    const full = text.match(/Estimated Full Recovery:\s*([^\r\n]+)/i);
    if (pct) wellness.recovery = { pct: +pct[1], level: lvl?.[1].trim() ?? null, fullIn: full?.[1].trim() ?? null };
  } catch (e) { console.warn("coros recovery:", String(e).slice(0, 120)); }

  try {
    const { text } = await mcpCall(token, "queryTrainingLoadAssessment", { days: 7 });
    const first = text.match(/(\d{4}-\d{2}-\d{2})\s+Comment:\s*([^\r\n]+?)\s+Short-Term Load:\s*(\d+)\s+Long-Term Load:\s*(\d+)\s+Load Ratio:\s*([\d.]+)/);
    if (first) wellness.load = { date: first[1], comment: first[2].trim(), shortTerm: +first[3], longTerm: +first[4], ratio: +first[5] };
  } catch (e) { console.warn("coros load:", String(e).slice(0, 120)); }

  // Historique jour par jour (0107) : sommeil, HRV de nuit, FC de repos.
  // 1re fois : 28 jours ; ensuite les 7 derniers jours (les nuits se complètent en retard).
  const backfilled = !!(conn.meta?.wellness_daily_since);
  try { await syncWellnessDaily(sb, conn, token, backfilled ? 7 : 28); wellness.dailySynced = true; }
  catch (e) { console.warn("coros wellness_daily:", String(e).slice(0, 160)); }

  const meta = { ...(conn.meta ?? {}), wellness,
    ...(wellness.dailySynced && !backfilled ? { wellness_daily_since: new Date().toISOString().slice(0, 10) } : {}) };
  await sb.from("device_connections").update({ meta }).eq("id", conn.id);

  // Renseigne checkins.hrv du jour SI un check-in existe déjà (ne pas en créer).
  // NB : la table checkins est indexée par `athlete_id` (= profiles.id = user_id).
  const hrvVal = (wellness.hrv as any)?.avgMs;
  if (hrvVal) {
    const today = new Date().toISOString().slice(0, 10);
    await sb.from("checkins")
      .update({ hrv: Math.round(hrvVal) })
      .eq("athlete_id", conn.user_id).eq("date", today).is("hrv", null);
  }
  return wellness;
}

// -----------------------------------------------------------------------------
//  ÉCRITURE — pousser une séance planifiée Sillance vers la montre COROS.
//  Vérifié disponible en direct le 29/09/2026 (createScheduledWorkout répond
//  correctement) — la note "coming soon" qui gardait ce chemin inerte depuis
//  la bêta COROS ne s'applique plus. Traduction scheduled_sessions.blocks →
//  section structurée COROS dans _shared/corosSessionMap.ts (créer/planifier
//  une séance = createScheduledWorkout, sportType run/cycling seulement —
//  limite de l'API COROS, pas de Sillance : natation/renfo/hyrox renvoient
//  "non supporté" à l'appelant, qui doit alors proposer le .FIT).
// -----------------------------------------------------------------------------
export async function corosWriteAvailable(sb: SupabaseClient, conn: any): Promise<boolean> {
  try {
    const token = await validToken(sb, conn);
    const tools = await mcpListTools(token);
    return tools.some((t) => /createScheduledWorkout|createSingleWorkout|scheduleWorkout/i.test(t));
  } catch { return false; }
}

/** yyyyMMdd dans le fuseau donné (COROS attend la date dans le fuseau du
 *  profil athlète ; on utilise UTC par défaut, comme le reste de l'intégration
 *  MCP — cohérent avec coros-poll qui ne connaît pas non plus le fuseau réel). */
function toCorosDate(dateIso: string): string {
  return dateIso.replace(/-/g, "").slice(0, 8);
}

/**
 * Pousse UNE séance planifiée Sillance vers le calendrier COROS de l'athlète
 * connecté. `session.blocks` = scheduled_sessions.blocks (le format du
 * créateur : blocs répétés, lignes en % d'une référence physio ou valeur
 * exacte) ; `dateIso` = la date visée (YYYY-MM-DD).
 * Lève une erreur explicite si la discipline n'est pas poussable (natation/
 * renfo/hyrox) — l'appelant doit alors proposer le repli .FIT.
 */
export async function pushPlannedSession(
  sb: SupabaseClient,
  conn: any,
  session: SillanceSessionForPush,
  dateIso: string,
  athleteRef: AthleteRef,
): Promise<{ ok: true; text: string }> {
  const course = sessionToCorosCourse(session, athleteRef);
  if (!course) {
    throw new Error(
      `COROS ne permet pas de créer une séance structurée pour la discipline "${session.disc}" ` +
      "(seulement course à pied et vélo) — propose l'export .FIT pour cette séance à la place.",
    );
  }
  const token = await validToken(sb, conn);
  const { text } = await mcpCall(token, "createScheduledWorkout", {
    date: toCorosDate(dateIso),
    course,
  });
  return { ok: true, text };
}

// -----------------------------------------------------------------------------
//  Santé jour par jour → wellness_daily (0107, 19/11/2026)
//  Textes COROS (format vérifié sur le compte de Rowan le 19/11) :
//   querySleepOverview : "2026-11-18\nSleep Score: 83\n...Main Sleep (asleep): 7h 4min\n
//                         Deep Sleep Ratio: 20%\n...REM Ratio: 19%\n...Awake Time: 19 min"
//                         (jour sans donnée : "Sleep Score: 0" + "not available yet" → ignoré)
//   querySleepHrv      : "2026-11-18:\n  HRV Avg: 68 ms — Normal\n  Normal Range: 58 - 100 ms\n  Baseline: 79 ms"
//                         (7 jours max par appel)
//   queryRestingHeartRate : "2026-11-18: 52 bpm"
//  Dates = jour du réveil, dans le fuseau COROS de l'athlète.
// -----------------------------------------------------------------------------
type WDay = Record<string, number | string | null>;
export function parseSleepOverview(text: string): Record<string, WDay> {
  const out: Record<string, WDay> = {};
  const blocks = text.split(/\n(?=\d{4}-\d{2}-\d{2}\s*\n)/);
  for (const b of blocks) {
    const d = b.match(/^(\d{4}-\d{2}-\d{2})\s*\n/m); if (!d) continue;
    if (/not available/i.test(b)) continue;
    const score = b.match(/Sleep Score:\s*(\d+)/i);
    const main = b.match(/Main Sleep \(asleep\):\s*(?:(\d+)h)?\s*(?:(\d+)\s*min)?/i);
    const mins = main && (main[1] || main[2]) ? (+(main[1] || 0)) * 60 + (+(main[2] || 0)) : null;
    if (!mins && !(score && +score[1] > 0)) continue;
    const pct = (re: RegExp) => { const m = b.match(re); return m ? +m[1] : null; };
    out[d[1]] = {
      sleep_score: score && +score[1] > 0 ? +score[1] : null,
      sleep_min: mins,
      deep_pct: pct(/Deep Sleep Ratio:\s*(\d+)\s*%/i),
      rem_pct: pct(/REM Ratio:\s*(\d+)\s*%/i),
      awake_min: pct(/Awake Time:\s*(\d+)\s*min/i),
    };
  }
  return out;
}
export function parseSleepHrv(text: string): Record<string, WDay> {
  const out: Record<string, WDay> = {};
  // seulement la partie « Assessment » (pas la série brute)
  const part = text.split(/Sleep HRV Time Series/i)[0];
  const re = /(\d{4}-\d{2}-\d{2}):\s*\n\s*HRV Avg:\s*(\d+)\s*ms\s*[—–-]\s*([^\n]+?)\s*\n\s*Normal Range:\s*(\d+)\s*-\s*(\d+)\s*ms\s*\n\s*Baseline:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) out[m[1]] = { hrv_ms: +m[2], hrv_eval: m[3].trim().slice(0, 40), hrv_low: +m[4], hrv_high: +m[5], hrv_baseline: +m[6] };
  return out;
}
export function parseRestingHr(text: string): Record<string, WDay> {
  const out: Record<string, WDay> = {};
  const re = /(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = { resting_hr: +m[2] };
  return out;
}
async function syncWellnessDaily(sb: SupabaseClient, conn: any, token: string, days: number): Promise<number> {
  const merged: Record<string, WDay> = {};
  const add = (src: Record<string, WDay>) => { for (const d in src) merged[d] = { ...(merged[d] ?? {}), ...src[d] }; };
  add(parseSleepOverview((await mcpCall(token, "querySleepOverview", { startDate: ymd(days - 1), endDate: ymd(0) })).text));
  for (let end = 0; end < days; end += 7) {   // HRV : 7 jours max par appel
    const start = Math.min(days - 1, end + 6);
    try { add(parseSleepHrv((await mcpCall(token, "querySleepHrv", { startDate: ymd(start), endDate: ymd(end) })).text)); }
    catch (e) { console.warn("coros hrv daily:", String(e).slice(0, 120)); }
  }
  try { add(parseRestingHr((await mcpCall(token, "queryRestingHeartRate", { days })).text)); }
  catch (e) { console.warn("coros rhr daily:", String(e).slice(0, 120)); }
  const dates = Object.keys(merged); if (!dates.length) return 0;
  // Ne jamais effacer une valeur déjà connue si un appel n'a rien renvoyé cette fois :
  // on part de la ligne existante (un upsert en lot met à NULL les colonnes absentes).
  const { data: prev } = await sb.from("wellness_daily").select("*")
    .eq("athlete_id", conn.user_id).eq("source", "coros").in("date", dates);
  const COLS = ["sleep_score", "sleep_min", "deep_pct", "rem_pct", "awake_min", "hrv_ms", "hrv_low", "hrv_high", "hrv_baseline", "hrv_eval", "resting_hr"];
  const rows = dates.map((date) => {
    const old = (prev ?? []).find((r: any) => r.date === date) ?? {};
    const row: Record<string, unknown> = { athlete_id: conn.user_id, date, source: "coros", updated_at: new Date().toISOString() };
    for (const c of COLS) row[c] = merged[date][c] ?? (old as any)[c] ?? null;
    return row;
  });
  const { error } = await sb.from("wellness_daily").upsert(rows, { onConflict: "athlete_id,date,source" });
  if (error) throw new Error(error.message);
  return rows.length;
}
