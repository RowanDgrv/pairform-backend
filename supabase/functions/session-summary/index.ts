// =============================================================================
//  Edge Function : session-summary
//  L'assistant IA du coach : reçoit le BILAN CHIFFRÉ d'une séance (calculé côté
//  app) et renvoie un verdict + des recommandations rédigés par Claude.
//
//  Body : {
//    session_key: string,          // identifiant stable de la séance
//    bilan: object,                // métriques déjà calculées (zones, decouple, pics…)
//    athlete_id?: string,
//    discipline?: string,
//    objective?: string,
//    force?: boolean               // true = régénérer même si déjà en cache
//  }
//  Auth : JWT. Gate : le coach DOIT avoir l'add-on IA actif (has_ai_addon).
//  Cache : un résumé déjà généré est relu depuis session_summaries (0 € API).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { summarize } from "../_shared/ai.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { session_key, bilan, athlete_id, discipline, objective, force } = await req.json();
    if (!session_key || !bilan) return json({ error: "session_key et bilan requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    // --- Gate add-on : jamais décidé côté front ---
    const { data: ok, error: gErr } = await supabase.rpc("has_ai_addon", { uid: user.id });
    if (gErr) throw gErr;
    if (!ok) return json({ error: "add_on_required", price_eur: 12 }, 402);

    // --- Cache : déjà généré ? ---
    if (!force) {
      const { data: cached } = await supabase
        .from("session_summaries")
        .select("verdict, headline, bullets, recos, model, created_at")
        .eq("coach_id", user.id)
        .eq("session_key", session_key)
        .maybeSingle();
      if (cached) return json({ ...cached, cached: true });
    }

    // --- Appel Claude (prompt caching côté lib) ---
    const { summary, model } = await summarize({
      ...(bilan as Record<string, unknown>),
      objective: objective ?? (bilan as Record<string, unknown>)?.objective,
    });

    // --- Persiste (upsert sur coach_id+session_key) → pas de double facturation ---
    const { error: upErr } = await supabase.from("session_summaries").upsert({
      coach_id: user.id,
      athlete_id: athlete_id ?? null,
      session_key,
      discipline: discipline ?? null,
      objective: objective ?? null,
      bilan,
      verdict: summary.verdict,
      headline: summary.headline,
      bullets: summary.bullets,
      recos: summary.recos,
      model,
    }, { onConflict: "coach_id,session_key" });
    if (upErr) console.error("[session-summary] upsert:", upErr);

    return json({ ...summary, model, cached: false });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
