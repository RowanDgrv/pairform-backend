// =============================================================================
//  Edge Function : device-sync  (import manuel des activités récentes)
//  Body : { provider?: 'strava' }   (défaut: strava)
//  Auth : JWT requis. Renvoie : { imported }.
// =============================================================================
import { admin, corsHeaders, json, userFromReq, stravaImportRecent } from "../_shared/providers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { provider = "strava" } = await req.json().catch(() => ({}));

    const { data: conn } = await sb.from("device_connections")
      .select("*").eq("user_id", user.id).eq("provider", provider).maybeSingle();
    if (!conn) return json({ error: `Aucune connexion ${provider}` }, 404);

    if (provider === "strava") {
      const imported = await stravaImportRecent(sb, conn);
      return json({ imported });
    }
    return json({ error: `Sync non implémentée pour ${provider}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
