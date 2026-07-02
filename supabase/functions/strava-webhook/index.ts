// =============================================================================
//  Edge Function : strava-webhook
//  Reçoit les push Strava (déployer avec `--no-verify-jwt`).
//   • GET  : validation de l'abonnement (renvoie hub.challenge si verify_token OK)
//   • POST : événement d'activité → on (ré)importe l'activité concernée.
//  Doit répondre 200 vite : Strava réessaie sinon.
//  Secret attendu : STRAVA_VERIFY_TOKEN (choisi par toi à la souscription).
// =============================================================================
import { admin, stravaValidToken, normalizeStravaActivity } from "../_shared/providers.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1) Handshake de validation Strava.
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = Deno.env.get("STRAVA_VERIFY_TOKEN") ?? "sillance";
    if (mode === "subscribe" && token === expected && challenge) {
      return new Response(JSON.stringify({ "hub.challenge": challenge }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // 2) Événement. On accuse réception tout de suite, traitement best-effort.
  let evt: any;
  try { evt = await req.json(); } catch { return new Response("ok"); }

  // On ne traite que les activités créées/mises à jour.
  if (evt?.object_type === "activity" && (evt.aspect_type === "create" || evt.aspect_type === "update")) {
    queueMicrotask(() => processActivity(evt).catch((e) => console.error("webhook:", e)));
  }
  // (aspect_type 'delete' → on pourrait supprimer la ligne ; volontairement ignoré ici.)

  return new Response("ok", { status: 200 });
});

async function processActivity(evt: any) {
  const sb = admin();
  // Retrouve la connexion par owner_id (= provider_user_id Strava).
  const { data: conn } = await sb.from("device_connections")
    .select("*").eq("provider", "strava").eq("provider_user_id", String(evt.owner_id)).maybeSingle();
  if (!conn) return;

  const token = await stravaValidToken(sb, conn);
  const res = await fetch(`https://www.strava.com/api/v3/activities/${evt.object_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) { console.error("fetch activity", res.status); return; }
  const act = await res.json();
  const row = normalizeStravaActivity(act, conn.user_id);
  await sb.from("external_activities").upsert(row, { onConflict: "provider,provider_activity_id" });
  await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
}
