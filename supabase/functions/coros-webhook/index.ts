// =============================================================================
//  Edge Function : coros-webhook  (déployer avec --no-verify-jwt)
//  Coros pousse les activités via data subscription. On résout l'utilisateur
//  par openId (= provider_user_id) puis on upsert les activités reçues.
//  Réponse attendue par Coros : { "message": "ok", "result": "0000" }.
// =============================================================================
import { admin } from "../_shared/providers.ts";
import { corosImportRecent } from "../_shared/coros.ts";

const OK = () =>
  new Response(JSON.stringify({ message: "ok", result: "0000" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return OK();
  let payload: any;
  try { payload = await req.json(); } catch { return OK(); }

  queueMicrotask(() => ingest(payload).catch((e) => console.error("coros-webhook:", e)));
  return OK();
});

async function ingest(payload: any) {
  const sb = admin();
  // ⚠️ SÉCURITÉ : le webhook n'est pas authentifié et Coros ne signe pas ses
  // pushes → on NE FAIT PAS confiance aux données d'activité du payload (un
  // pirate pourrait injecter de fausses activités chez un athlète en connaissant
  // son openId). Le payload sert UNIQUEMENT de déclencheur : pour chaque openId
  // correspondant à une connexion réelle, on RE-TÉLÉCHARGE les activités via
  // l'API Coros authentifiée avec le jeton stocké (corosImportRecent).
  const groups: any[] = payload?.sportDataList ?? payload?.data ?? [payload];
  const seen = new Set<string>();
  for (const g of groups) {
    const openId = String(g?.openId ?? g?.userId ?? payload?.openId ?? "");
    if (!openId || seen.has(openId)) continue;
    seen.add(openId);
    const { data: conn } = await sb.from("device_connections")
      .select("*").eq("provider", "coros").eq("provider_user_id", openId).maybeSingle();
    if (!conn) continue;
    try { await corosImportRecent(sb, conn); } catch (e) { console.error("coros re-fetch:", e); }
  }
}
