// =============================================================================
//  _shared/fcm.ts — Envoi de notifications push Android natives via Firebase
//  Cloud Messaging (API HTTP v1). Utilisé par morning-digest et
//  coach-alert-on-checkin pour les abonnements push_subscriptions.platform
//  = 'android' uniquement.
//
//  iOS n'utilise PAS ce chemin : @capacitor/push-notifications donne sur iOS
//  le jeton APNs brut (pas un jeton FCM — la conversion nécessiterait le SDK
//  Firebase natif iOS, non installé ici), donc les jetons platform='ios' sont
//  envoyés directement à Apple via _shared/apns.ts. Voir capacitor-native.js
//  (silRegisterPush) côté client pour l'origine de cette distinction.
//
//  Secret requis : FCM_SERVICE_ACCOUNT_JSON — le JSON du compte de service
//  Firebase (Console Firebase > Paramètres du projet > Comptes de service >
//  Générer une nouvelle clé privée), collé tel quel comme valeur du secret.
//  Sans ce secret : sendFcmPush() renvoie { ok:false } sans lancer d'erreur,
//  pour ne jamais faire échouer l'appelant (même logique que VAPID_KEYS_JSON
//  absent dans morning-digest).
// =============================================================================

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// Échange le compte de service contre un access token OAuth2 (JWT bearer
// grant, flux serveur-à-serveur standard Google) — mis en cache jusqu'à
// expiration (1h) pour ne pas re-signer un JWT à chaque notification envoyée.
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = new TextEncoder();
  const unsigned = `${base64url(enc.encode(JSON.stringify(header)))}.${
    base64url(enc.encode(JSON.stringify(claims)))
  }`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`FCM auth échouée : ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
  return cachedToken.value;
}

export function fcmConfigured(): boolean {
  return !!Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
}

/* Envoie une notification à un jeton FCM. Renvoie ok:false + deadToken:true
   si le jeton n'est plus valide (app désinstallée, jeton expiré) — à
   l'appelant de supprimer la ligne push_subscriptions correspondante. */
export async function sendFcmPush(
  token: string,
  { title, body, data }: { title: string; body: string; data?: Record<string, string> },
): Promise<{ ok: boolean; deadToken?: boolean; error?: string }> {
  const saJson = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
  if (!saJson) return { ok: false, error: "FCM_SERVICE_ACCOUNT_JSON absent" };

  try {
    const sa: ServiceAccount = JSON.parse(saJson);
    const accessToken = await getAccessToken(sa);

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: data ?? {},
          },
        }),
      },
    );
    if (res.ok) return { ok: true };
    const errText = await res.text();
    const deadToken = res.status === 404 ||
      errText.includes("UNREGISTERED") ||
      errText.includes("INVALID_ARGUMENT") ||
      errText.includes("NOT_FOUND");
    return { ok: false, deadToken, error: errText.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
