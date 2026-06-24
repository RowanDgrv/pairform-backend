// =============================================================================
//  OAuth 1.0a — signature HMAC-SHA1 (RFC 5849), pour l'API Garmin.
//  Implémenté avec Web Crypto (disponible dans Deno). Testé en isolation
//  contre le HMAC de Node (voir test/oauth1.test.mjs) pour garantir la signature.
// =============================================================================

/** Encodage pourcentage strict RFC 3986 (unreserved = A-Za-z0-9-_.~). */
export function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** HMAC-SHA1 → base64. */
export async function hmacSha1Base64(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return toBase64(sig);
}

export interface Oauth1Opts {
  method: string;
  url: string;                       // sans query string (les query params vont dans `params`)
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  /** Paramètres oauth_* additionnels (oauth_callback, oauth_verifier). */
  extraOauth?: Record<string, string>;
  /** Paramètres de requête (query + body form-urlencoded) à inclure dans la signature. */
  params?: Record<string, string>;
}

/** Construit l'en-tête Authorization OAuth 1.0a signé. */
export async function oauth1Header(o: Oauth1Opts): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: o.consumerKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(o.token ? { oauth_token: o.token } : {}),
    ...(o.extraOauth ?? {}),
  };

  // Base string : tous les params (oauth + requête), encodés, triés.
  const all: Record<string, string> = { ...oauth, ...(o.params ?? {}) };
  const sortedPairs = Object.keys(all).sort().map(
    (k) => `${pctEncode(k)}=${pctEncode(all[k])}`,
  );
  const paramString = sortedPairs.join("&");
  const baseString = [
    o.method.toUpperCase(),
    pctEncode(o.url),
    pctEncode(paramString),
  ].join("&");

  const signingKey = `${pctEncode(o.consumerSecret)}&${pctEncode(o.tokenSecret ?? "")}`;
  oauth.oauth_signature = await hmacSha1Base64(signingKey, baseString);

  // En-tête : uniquement les oauth_*.
  const header = "OAuth " + Object.keys(oauth).sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
    .join(", ");
  return header;
}
