// =============================================================================
//  Edge Function : device-disconnect
//  Body : { provider: 'strava' | ... }   Auth : JWT requis.
//  Supprime la connexion et révoque le jeton côté plateforme si possible.
// =============================================================================
import { admin, corsHeaders, json, userFromReq, stravaValidToken } from "../_shared/providers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { provider } = await req.json();
    if (!provider) return json({ error: "provider requis" }, 400);

    const { data: conn } = await sb.from("device_connections")
      .select("*").eq("user_id", user.id).eq("provider", provider).maybeSingle();

    // Révocation côté plateforme (best-effort).
    if (conn && provider === "strava") {
      try {
        const token = await stravaValidToken(sb, conn);
        await fetch("https://www.strava.com/oauth/deauthorize", {
          method: "POST", headers: { Authorization: `Bearer ${token}` },
        });
      } catch (e) { console.error("deauthorize:", e); }
    }

    await sb.from("device_connections").delete().eq("user_id", user.id).eq("provider", provider);
    return json({ disconnected: true });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
