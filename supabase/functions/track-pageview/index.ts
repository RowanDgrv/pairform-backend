// =============================================================================
//  Edge Function : track-pageview
//  Mesure d'audience anonyme (catégorie "analytics" du bandeau cookies).
//  Appelée uniquement si l'utilisateur a accepté cette catégorie
//  (sillance-cookies.js, window.SilCookies.has('analytics')) — jamais par
//  défaut. Ne reçoit et ne stocke aucune donnée personnelle : ni IP, ni
//  user_id, ni identifiant visiteur. Body : { path, referrer_host, lang }.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const ALLOWED_LANGS = ["fr", "en", "es"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

    // path : pathname seul, jamais la query string (peut porter des tokens
    // d'invitation/spectateur/créneau) ni le fragment.
    let path = typeof body.path === "string" ? body.path : "/";
    path = path.split("?")[0].split("#")[0].slice(0, 200);
    if (!path.startsWith("/")) path = "/" + path;

    // referrer_host : host seul (le client envoie déjà location.hostname d'une
    // page tierce, mais on ceinture-bretelles au cas où une URL complète arrive).
    let referrerHost: string | null = typeof body.referrer_host === "string" ? body.referrer_host : null;
    if (referrerHost) {
      try { referrerHost = new URL(referrerHost.includes("://") ? referrerHost : `https://${referrerHost}`).hostname; }
      catch { referrerHost = referrerHost.slice(0, 100); }
      referrerHost = referrerHost.slice(0, 100) || null;
    }

    const lang = ALLOWED_LANGS.includes(body.lang) ? body.lang : null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error } = await supabase.from("pageviews").insert({ path, referrer_host: referrerHost, lang });
    if (error) throw error;

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
