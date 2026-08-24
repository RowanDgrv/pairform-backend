// =============================================================================
//  _shared/tokenCrypto.ts
//  Chiffrement applicatif des jetons OAuth stockés dans device_connections
//  (access_token, refresh_token, token_secret) — audit sécurité 23-24/08/2026,
//  point optionnel "chiffrement des données sensibles".
//
//  Ces colonnes sont déjà protégées par la RLS (aucune policy client, lecture/
//  écriture réservées au service_role — voir 0005_device_sync.sql) : ce
//  chiffrement est une couche de défense EN PLUS, pas un remplacement. Il ne
//  couvre QUE ces 3 colonnes, jamais les données de santé (checkins) : ces
//  dernières doivent rester en clair pour que Postgres ET le moteur
//  d'analyse côté app puissent calculer des moyennes/tendances dessus — les
//  chiffrer casserait toutes les fonctionnalités d'analyse (charge, TSB,
//  HRV baseline, etc.). Pour les checkins, la RLS reste le contrôle adapté.
//
//  AES-256-GCM (Web Crypto natif, aucune dépendance). Clé : secret
//  OAUTH_TOKEN_ENC_KEY (32 octets, encodée en base64) — à générer une fois :
//    openssl rand -base64 32
//  puis : supabase secrets set OAUTH_TOKEN_ENC_KEY=<valeur>
//
//  Rétrocompatible : une valeur déjà en base sans le préfixe "enc:" est
//  renvoyée telle quelle par decryptToken (ancien jeton en clair, écrit
//  avant ce correctif) — pas de migration de données requise, chaque jeton
//  se chiffre de lui-même au prochain refresh/re-connexion.
// =============================================================================

const PREFIX = "enc:";
let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const b64 = Deno.env.get("OAUTH_TOKEN_ENC_KEY");
  if (!b64) throw new Error("OAUTH_TOKEN_ENC_KEY non configuré");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  cachedKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return cachedKey;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptToken(plain: string | null | undefined): Promise<string | null> {
  if (plain == null) return null;
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return PREFIX + toBase64(combined);
}

export async function decryptToken(stored: string | null | undefined): Promise<string | null> {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) return stored; // jeton pré-chiffrement, encore en clair
  const key = await getKey();
  const combined = fromBase64(stored.slice(PREFIX.length));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

/** Déchiffre les 3 colonnes sensibles d'une ligne device_connections lue en base. */
export async function decryptConn<T extends { access_token?: string | null; refresh_token?: string | null; token_secret?: string | null }>(
  conn: T | null,
): Promise<T | null> {
  if (!conn) return conn;
  return {
    ...conn,
    access_token: await decryptToken(conn.access_token),
    refresh_token: await decryptToken(conn.refresh_token),
    token_secret: conn.token_secret !== undefined ? await decryptToken(conn.token_secret) : conn.token_secret,
  };
}
