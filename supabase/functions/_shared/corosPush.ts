// =============================================================================
//  _shared/corosPush.ts
//  Vérification + normalisation du "Daily Data Push" COROS (API Reference
//  V2.1.1 §5.5 — mail COROS Partner Dev du 11/09/2026).
//  ---------------------------------------------------------------------------
//  ⚠️ Le document COROS décrit QUOI vérifier (client, secret, signature,
//  nonce, timestamp) mais ne documente PAS l'algorithme de signature (aucune
//  mention d'HMAC/SHA dans les 75 pages du PDF fourni). Tant que COROS n'a
//  pas confirmé cet algorithme par écrit, on ne peut vérifier QUE client+
//  secret (le mécanisme que le PDF documente sans ambiguïté, §5.5.2/5.5.3).
//  → verifyPush() vérifie client+secret et journalise si signature/nonce/
//    timestamp sont absents, mais ne les valide pas cryptographiquement.
//  À DURCIR dès que COROS répond sur le point (demande à inclure dans la
//  réponse qui leur communique l'URL de réception).
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptToken, decryptToken } from "./tokenCrypto.ts";

export interface CorosDailyEntry {
  happenDay: number;          // yyyyMMdd
  sleepStartTime?: string;    // "yyyy-MM-dd HH:mm:ss"
  sleepEndTime?: string;
  calorie?: number;
  step?: number;
  rhr?: number;
  hrvList?: { hrv: number; hr?: number; timestamp: number }[];
  ppgHrv?: number;
  sleepAvgHr?: number;
}

export interface CorosDailyBatch {
  batchDailyList: { openId: string; dailyList: CorosDailyEntry[] }[];
  client?: string;
  secret?: string;
  signature?: string;
  nonce?: string;
  timestamp?: string;
}

/** Lit le couple client_id/secret attribué par COROS (déchiffré). */
export async function loadPushCredentials(sb: SupabaseClient, provider: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const { data } = await sb.from("partner_push_credentials").select("*").eq("provider", provider).maybeSingle();
  const secret = data ? await decryptToken(data.client_secret) : null;
  if (!data || !secret) return null;
  return { clientId: data.client_id, clientSecret: secret };
}

/** Enregistre (ou remplace) le couple client_id/secret attribué par COROS. */
export async function savePushCredentials(sb: SupabaseClient, provider: string, clientId: string, clientSecret: string) {
  await sb.from("partner_push_credentials").upsert({
    provider,
    client_id: clientId,
    client_secret: await encryptToken(clientSecret),
  }, { onConflict: "provider" });
}

/**
 * Vérifie un push entrant. Accepte client/secret en header (convention
 * documentée pour le push voisin §5.3) ou dans le corps (le §5.5 les liste
 * au même niveau que batchDailyList sans trancher l'emplacement) — on
 * accepte les deux plutôt que de rejeter un push légitime sur une ambiguïté
 * de notre lecture du PDF.
 */
export function verifyPush(req: Request, body: CorosDailyBatch, creds: { clientId: string; clientSecret: string }): boolean {
  const headerClient = req.headers.get("client") ?? req.headers.get("x-coros-client");
  const headerSecret = req.headers.get("secret") ?? req.headers.get("x-coros-secret");
  const client = headerClient ?? body.client;
  const secret = headerSecret ?? body.secret;
  if (!body.signature || !body.nonce || !body.timestamp) {
    console.warn("coros-daily-push: signature/nonce/timestamp absents — vérification limitée à client+secret (algorithme non documenté par COROS)");
  }
  return client === creds.clientId && secret === creds.clientSecret;
}

function parseHappenDay(day: number): string {
  const s = String(day);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** happenDay + heure locale "yyyy-MM-dd HH:mm:ss" (fuseau du device, jamais recalculé) → ISO. */
function parseLocalDateTime(s?: string): string | null {
  if (!s) return null;
  const iso = s.replace(" ", "T");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Ingère un batch complet : résout l'openId → user_id connu, upsert les jours. */
export async function ingestDailyBatch(sb: SupabaseClient, batch: CorosDailyBatch): Promise<{ upserted: number; unresolved: number }> {
  let upserted = 0, unresolved = 0;
  for (const entry of batch.batchDailyList ?? []) {
    const { data: conn } = await sb.from("device_connections")
      .select("user_id").eq("provider", "coros").eq("provider_user_id", entry.openId).maybeSingle();
    if (!conn) unresolved++;

    const rows = (entry.dailyList ?? []).map((d) => ({
      user_id: conn?.user_id ?? null,
      provider: "coros" as const,
      provider_open_id: entry.openId,
      day: parseHappenDay(d.happenDay),
      sleep_start: parseLocalDateTime(d.sleepStartTime),
      sleep_end: parseLocalDateTime(d.sleepEndTime),
      calories: d.calorie ?? null,
      steps: d.step ?? null,
      resting_hr: d.rhr ?? null,
      hrv_avg: d.ppgHrv ?? null,
      sleep_avg_hr: d.sleepAvgHr ?? null,
      raw: d,
    }));
    if (!rows.length) continue;
    const { error } = await sb.from("device_daily_metrics")
      .upsert(rows, { onConflict: "provider,provider_open_id,day" });
    if (error) { console.error("coros-daily-push upsert:", error.message); continue; }
    upserted += rows.length;
  }
  return { upserted, unresolved };
}
