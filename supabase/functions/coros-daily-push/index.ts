// =============================================================================
//  Edge Function : coros-daily-push   (déployer avec --no-verify-jwt)
//  Reçoit le "Daily Data Push" COROS — API Reference V2.1.1 §5.5 (sommeil, FC
//  repos, VFC, pas, calories des 3 derniers jours de chaque athlète connecté).
//  ---------------------------------------------------------------------------
//   • GET  : "Service Status Check API" attendue par COROS avant activation
//            (doit répondre 200 pour que le push soit activé côté COROS).
//   • POST : le batch réel. Doit répondre vite ({result:"0000"}) : tout code
//            différent fait re-pousser le batch entier par COROS.
//  Non déployée tant que partner_push_credentials n'a pas de ligne 'coros'
//  (voir _shared/corosPush.ts::savePushCredentials, à exécuter une fois que
//  COROS a transmis client_id/secret après réception de cette URL).
// =============================================================================
import { admin } from "../_shared/providers.ts";
import { loadPushCredentials, verifyPush, ingestDailyBatch, CorosDailyBatch } from "../_shared/corosPush.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "GET") return new Response("ok", { status: 200 });
  if (req.method !== "POST") return json({ result: "4000", message: "method not allowed" }, 405);

  let body: CorosDailyBatch;
  try { body = await req.json(); }
  catch { return json({ result: "4001", message: "invalid json" }, 400); }

  const sb = admin();
  const creds = await loadPushCredentials(sb, "coros");
  if (!creds) {
    // Pas encore configuré (savePushCredentials jamais appelé) : on ne peut
    // pas vérifier l'appelant → on refuse plutôt que d'ingérer en confiance.
    console.error("coros-daily-push: aucune credential enregistrée pour 'coros'");
    return json({ result: "5000", message: "not configured" }, 500);
  }
  if (!verifyPush(req, body, creds)) {
    return json({ result: "4010", message: "invalid client/secret" }, 401);
  }

  try {
    const { upserted, unresolved } = await ingestDailyBatch(sb, body);
    if (unresolved) console.warn(`coros-daily-push: ${unresolved} openId sans device_connections correspondante`);
    return json({ result: "0000", message: "ok" });
  } catch (e) {
    console.error("coros-daily-push:", e);
    return json({ result: "5001", message: "internal error" }, 500);
  }
});
