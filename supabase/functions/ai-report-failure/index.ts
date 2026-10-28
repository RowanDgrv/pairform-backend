// =============================================================================
//  Edge Function : ai-report-failure (28/10/2026)
//  Signalé par l'APP quand une analyse IA échoue SANS que le serveur ait pu
//  répondre (code network_* : requête jamais arrivée, fonction coupée,
//  extension qui bloque…). Les échecs vus par le serveur sont déjà alertés
//  par session-summary / week-review eux-mêmes : pas de doublon.
//  Body : { fn: "session-summary"|"week-review", detail: string, context? }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { alertAiFailure } from "../_shared/aiAlert.ts";

const FNS = new Set(["session-summary", "week-review", "session-report"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { fn, detail, context } = await req.json();
    if (!FNS.has(fn) || typeof detail !== "string" || !/^network/.test(detail)) {
      return json({ error: "requête invalide" }, 400);
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);
    const safeCtx = context && typeof context === "object"
      ? Object.fromEntries(Object.entries(context).slice(0, 8).map(([k, v]) => [k, String(v).slice(0, 120)]))
      : null;
    await alertAiFailure(supabase, {
      fn, stage: "browser", userId: user.id, detail: detail.slice(0, 80),
      context: { ...(safeCtx ?? {}), ua: (req.headers.get("user-agent") ?? "").slice(0, 160) },
    });
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
