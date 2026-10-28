// =============================================================================
//  Edge Function : track-pageview
//  Mesure d'audience anonyme (catégorie "analytics" du bandeau cookies).
//  Mesure exemptée de consentement depuis 0078 (28/10/2026) : envoyée par
//  défaut, jamais si le visiteur a refusé dans le bandeau (opposition).
//  Ne reçoit et ne stocke aucune donnée personnelle : ni IP, ni user_id, ni
//  identifiant persistant (visit_id = aléatoire, durée de l'onglet).
//  Body : { path, referrer_host, lang, event?, label?, visit_id?, src? }.
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
    // 0078 : événements, visite et source. Formats fermés : rien de libre,
    // rien de personnel ne peut passer (pas de texte saisi, pas d'email).
    const pick = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
    const event = pick(body.event, /^[a-z0-9_]{1,30}$/) ?? "view";
    const label = pick(body.label, /^[A-Za-z0-9_.\-\/#?=&]{1,80}$/);
    const visitId = pick(body.visit_id, /^[a-z0-9]{8,32}$/);
    const src = pick(typeof body.src === "string" ? body.src.toLowerCase() : null, /^[a-z0-9_-]{1,30}$/);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error } = await supabase.from("pageviews").insert({ path, referrer_host: referrerHost, lang, event, label, visit_id: visitId, src });
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
