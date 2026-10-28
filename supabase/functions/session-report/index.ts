// =============================================================================
//  Edge Function : session-report (28/10/2026)
//  Rapport complet d'une séance (consigne « analyste performance » en 7
//  étapes). L'app envoie un DOSSIER de valeurs déjà calculées (aucun nom,
//  e-mail ni identifiant ; cycle menstruel seulement s'il est renseigné) ;
//  l'IA (Groq, Claude en repli) interprète et rédige en JSON structuré.
//  Mêmes garde-fous que session-summary : add-on IA requis, cache par
//  coach+séance (pas de double génération), alerte e-mail à l'admin en cas
//  d'échec. Body : { session_key, athlete_id?, dossier, force? }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { alertAiFailure } from "../_shared/aiAlert.ts";
import { generateReport, aiErrorDetail } from "../_shared/ai.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  let stage = "unknown";
  let userId: string | null = null;
  let ctx: Record<string, unknown> = {};
  // deno-lint-ignore no-explicit-any
  let supa: any = null;

  try {
    const { session_key, athlete_id, dossier, force } = await req.json();
    if (!session_key || !dossier || typeof dossier !== "object") {
      return json({ error: "session_key et dossier requis" }, 400);
    }
    // Garde-fou taille : un dossier normal fait quelques ko.
    if (JSON.stringify(dossier).length > 60000) return json({ error: "dossier trop volumineux" }, 413);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);
    userId = user.id; supa = supabase; ctx = { session_key, athlete_id: athlete_id ?? null };

    stage = "addon";
    const { data: ok, error: gErr } = await supabase.rpc("has_ai_addon", { uid: user.id });
    if (gErr) throw gErr;
    if (!ok) return json({ error: "add_on_required", price_eur: 12 }, 402);

    stage = "cache";
    if (!force) {
      const { data: cached } = await supabase.from("session_reports")
        .select("report, model, created_at").eq("coach_id", user.id).eq("session_key", session_key).maybeSingle();
      if (cached) return json({ ...cached, cached: true });
    }

    stage = "ia";
    const { report, model } = await generateReport(dossier);

    const { error: upErr } = await supabase.from("session_reports").upsert({
      coach_id: user.id, athlete_id: athlete_id ?? null, session_key, report, model,
    }, { onConflict: "coach_id,session_key" });
    if (upErr) {
      await alertAiFailure(supabase, { fn: "session-report", stage: "save", userId, detail: "save_failed", error: upErr, context: ctx });
      console.error("[session-report] upsert:", upErr);
    }
    return json({ report, model, cached: false });
  } catch (e) {
    console.error(e);
    const detail = aiErrorDetail(e);
    if (supa) await alertAiFailure(supa, { fn: "session-report", stage, userId, detail, error: e, context: ctx });
    return json({ error: "ai_failed", detail }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
