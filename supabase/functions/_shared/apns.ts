// =============================================================================
//  _shared/apns.ts — Envoi de notifications push iOS natives directement à
//  Apple (APNs, HTTP/2), sans passer par Firebase.
//
//  Pourquoi pas FCM pour iOS aussi : @capacitor/push-notifications utilise le
//  SDK Firebase natif sur Android (le jeton reçu EST un jeton FCM), mais sur
//  iOS il s'appuie sur UNUserNotificationCenter directement — le jeton reçu
//  est le jeton APNs brut de l'appareil, pas un jeton FCM. FCM n'accepterait
//  pas ce jeton tel quel (il faudrait le SDK Firebase iOS, non installé ici,
//  pour l'échanger). L'envoi direct à Apple est donc plus simple ET n'exige
//  aucun projet Firebase pour la partie iOS : seule la clé APNs suffit.
//
//  Secrets requis (portail developer.apple.com > Certificates, Identifiers &
//  Profiles > Keys > + > Apple Push Notifications service (APNs)) :
//    APNS_KEY_P8     — contenu du fichier .p8 téléchargé (une seule fois,
//                      Apple ne permet pas de le re-télécharger après coup).
//    APNS_KEY_ID     — identifiant à 10 caractères de cette clé.
//    APNS_TEAM_ID    — Team ID du compte Apple Developer (10 caractères).
//    APNS_BUNDLE_ID  — optionnel, défaut 'app.sillance.mobile' (capacitor.config.json).
//    APNS_ENV        — 'sandbox' en développement (build Xcode non signée
//                      pour distribution), 'production' par défaut sinon.
// =============================================================================

let cachedJwt: { value: string; issuedAt: number } | null = null;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importP8Key(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// Jeton provider APNs (JWT ES256) : Apple demande de ne pas en signer un
// nouveau à chaque notification (max recommandé ~1 par 20 min) — mis en
// cache et réutilisé tant qu'il a moins de 30 min.
async function getProviderJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 1800) return cachedJwt.value;

  const keyId = Deno.env.get("APNS_KEY_ID")!;
  const teamId = Deno.env.get("APNS_TEAM_ID")!;
  const pem = Deno.env.get("APNS_KEY_P8")!;

  const header = { alg: "ES256", kid: keyId };
  const claims = { iss: teamId, iat: now };
  const enc = new TextEncoder();
  const unsigned = `${base64url(enc.encode(JSON.stringify(header)))}.${
    base64url(enc.encode(JSON.stringify(claims)))
  }`;
  const key = await importP8Key(pem);
  // ECDSA P-256 via Web Crypto renvoie directement la signature au format
  // IEEE P1363 (r||s concaténés) — c'est exactement le format JOSE attendu
  // pour ES256, aucune conversion DER→raw nécessaire ici.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;
  cachedJwt = { value: jwt, issuedAt: now };
  return jwt;
}

export function apnsConfigured(): boolean {
  return !!(Deno.env.get("APNS_KEY_P8") && Deno.env.get("APNS_KEY_ID") && Deno.env.get("APNS_TEAM_ID"));
}

export async function sendApnsPush(
  deviceToken: string,
  { title, body, data }: { title: string; body: string; data?: Record<string, string> },
): Promise<{ ok: boolean; deadToken?: boolean; error?: string }> {
  if (!apnsConfigured()) return { ok: false, error: "secrets APNS_* absents" };
  try {
    const jwt = await getProviderJwt();
    const bundleId = Deno.env.get("APNS_BUNDLE_ID") ?? "app.sillance.mobile";
    const host = Deno.env.get("APNS_ENV") === "sandbox"
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com";

    const res = await fetch(`https://${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${jwt}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      // data éventuelle en clés top-level (hors "aps"), lue côté client via
      // action.notification.data — voir pushNotificationActionPerformed dans
      // capacitor-native.js et window.silOnNotificationTap.
      body: JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, ...(data ?? {}) }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text();
    // BadDeviceToken (jeton mal formé) / Unregistered (app désinstallée)
    const deadToken = res.status === 400 || res.status === 410;
    return { ok: false, deadToken, error: errText.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
