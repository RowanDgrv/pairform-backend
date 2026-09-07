// =============================================================================
//  Edge Function : coros-poll     (déployer avec --no-verify-jwt)
//  ---------------------------------------------------------------------------
//  Le serveur MCP COROS self-service N'A PAS de webhook → on tire les activités
//  et le bilan wellness de chaque athlète connecté sur planning.
//
//  Déclencheur : pg_cron toutes les ~2 h → POST avec header x-cron-secret
//  (même schéma que morning-digest / coach-alert-on-checkin).
//
//  Secrets : CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//            OAUTH_TOKEN_ENC_KEY  (+ COROS_MCP_BASE / COROS_MCP_CLIENT_ID facultatifs).
//
//  Prudence quota : COROS limite à 50 .fit/jour/compte. importRecent ne résout
//  qu'un petit lot d'URL .FIT par passe (withFit) et saute celles déjà connues.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { decryptConn } from "../_shared/tokenCrypto.ts";
import { importRecent, fetchWellness } from "../_shared/corosMcp.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Optionnel : ne traiter qu'un athlète (POST { user_id }) — utile pour un
  // "resync maintenant" déclenché depuis l'app sans exposer device-sync au cron.
  let onlyUser: string | null = null;
  try { onlyUser = (await req.json())?.user_id ?? null; } catch { /* pas de body */ }

  let q = sb.from("device_connections").select("*").eq("provider", "coros");
  if (onlyUser) q = q.eq("user_id", onlyUser);
  const { data: conns, error } = await q;
  if (error) return json({ error: error.message }, 500);

  let ok = 0, imported = 0, failed = 0;
  for (const row of conns ?? []) {
    const conn = await decryptConn(row);
    try {
      imported += await importRecent(sb, conn, 21, onlyUser ? 20 : 8);
      await fetchWellness(sb, conn);
      ok++;
    } catch (e) {
      failed++;
      console.error("coros-poll", conn.user_id, String(e).slice(0, 200));
    }
  }
  return json({ ok, imported, failed, total: conns?.length ?? 0 });
});
