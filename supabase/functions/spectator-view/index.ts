// =============================================================================
//  Edge Function : spectator-view (PUBLIC, --no-verify-jwt)
//  Lit un lien spectateur par token, sans authentification — sert la page
//  publique spectateur.html. Ne renvoie QUE le strict nécessaire : nom de
//  l'athlète, course, repères laissés par le coach/l'athlète, et le résultat
//  s'il est disponible (via race_debriefs, si rempli pour la même course).
//  PAS de position GPS live : cette donnée n'existe pas côté Sillance (voir
//  commentaire migration 0032).
//  Query ou body : { token: string }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    let token = url.searchParams.get("token");
    if (!token && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      token = body.token;
    }
    if (!token) return json({ error: "token requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: link } = await supabase.from("spectator_links")
      .select("athlete_id, race_name, race_date, pacing_notes").eq("token", token).maybeSingle();
    if (!link) return json({ error: "Lien introuvable" }, 404);

    const { data: athlete } = await supabase.from("profiles")
      .select("full_name").eq("id", link.athlete_id).maybeSingle();
    const { data: debrief } = await supabase.from("race_debriefs")
      .select("result, felt").eq("athlete_id", link.athlete_id)
      .eq("race_name", link.race_name).eq("race_date", link.race_date).maybeSingle();

    return json({
      athleteName: athlete?.full_name || "L'athlète",
      raceName: link.race_name,
      raceDate: link.race_date,
      pacingNotes: link.pacing_notes || null,
      result: debrief?.result || null,
      felt: debrief?.felt || null,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
