// =============================================================================
//  Edge Function : week-review
//  L'assistant IA du coach, version HEBDOMADAIRE : reçoit la liste des séances
//  déjà RÉALISÉES par un athlète sur une semaine et renvoie un verdict +
//  recommandations rédigés par Claude, pour la semaine suivante.
//
//  Body : {
//    athlete_id: string,
//    week_key: string,              // lundi ISO de la semaine affichée
//    sessions: object[],            // séances déjà calculées côté app
//    force?: boolean                // true = régénérer même si déjà en cache
//  }
//  Auth : JWT. Gate : le coach DOIT avoir l'add-on IA actif (has_ai_addon,
//  qui couvre déjà solo + club premium + staff — rien à refaire ici).
//  Cache : une synthèse déjà générée est relue depuis week_reviews (0 € API) —
//  un clic répété sur le bouton ne redéclenche JAMAIS d'appel Claude.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { summarizeWeek } from "../_shared/ai.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { athlete_id, week_key, sessions, force } = await req.json();
    if (!week_key || !Array.isArray(sessions)) {
      return json({ error: "week_key et sessions requis" }, 400);
    }
    if (!sessions.length) {
      return json({ error: "no_sessions" }, 400);
    }

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

    // --- Cache : déjà généré pour cette semaine+athlète ? ---
    // (.eq("athlete_id", null) ne matcherait jamais une colonne NULL en SQL —
    // il faut .is() dans ce cas précis, cf. bug identique évité ici.)
    if (!force) {
      let q = supabase
        .from("week_reviews")
        .select("verdict, headline, bullets, recos, model, created_at")
        .eq("coach_id", user.id)
        .eq("week_key", week_key);
      q = athlete_id ? q.eq("athlete_id", athlete_id) : q.is("athlete_id", null);
      const { data: cached } = await q.maybeSingle();
      if (cached) return json({ ...cached, cached: true });
    }

    // --- Appel Claude (prompt caching côté lib) ---
    const { summary, model } = await summarizeWeek(sessions);

    // --- Persiste (upsert sur coach_id+athlete_id+week_key) → pas de double facturation ---
    const { error: upErr } = await supabase.from("week_reviews").upsert({
      coach_id: user.id,
      athlete_id: athlete_id ?? null,
      week_key,
      sessions,
      verdict: summary.verdict,
      headline: summary.headline,
      bullets: summary.bullets,
      recos: summary.recos,
      model,
    }, { onConflict: "coach_id,athlete_id,week_key" });
    if (upErr) console.error("[week-review] upsert:", upErr);

    return json({ ...summary, model, cached: false });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
