// =============================================================================
//  Edge Function : coros-webhook  (déployer avec --no-verify-jwt)
//  Coros pousse les activités via data subscription. On résout l'utilisateur
//  par openId (= provider_user_id) puis on upsert les activités reçues.
//  Réponse attendue par Coros : { "message": "ok", "result": "0000" }.
// =============================================================================
import { admin } from "../_shared/providers.ts";
import { corosUpsertActivities } from "../_shared/coros.ts";

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
  // Coros regroupe les activités par utilisateur (openId) dans sportDataList.
  const groups: any[] = payload?.sportDataList ?? payload?.data ?? [payload];
  for (const g of groups) {
    const openId = g.openId ?? g.userId ?? payload.openId;
    if (!openId) continue;
    const { data: conn } = await sb.from("device_connections")
      .select("*").eq("provider", "coros").eq("provider_user_id", String(openId)).maybeSingle();
    if (!conn) continue;
    const acts: any[] = g.sportData ?? g.activities ?? (Array.isArray(g) ? g : [g]);
    await corosUpsertActivities(sb, acts, conn.user_id);
    await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
  }
}
