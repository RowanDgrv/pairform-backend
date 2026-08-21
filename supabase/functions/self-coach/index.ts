// =============================================================================
//  Edge Function : self-coach
//  Permet à un coach de se rattacher lui-même comme athlète (self-coaching) :
//  il gère son propre planning/check-ins comme un athlète classique, tout en
//  restant compté dans son propre quota d'athlètes (palier de prix).
//  Body : {} — le coach connecté (JWT) s'auto-rattache.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: profile } = await supabase
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "coach") {
      return json({ error: "Réservé aux comptes coach" }, 403);
    }

    // Lien auto-référent (coach_id = athlete_id = user.id), idempotent.
    await supabase.from("coach_athlete").upsert(
      { coach_id: user.id, athlete_id: user.id, status: "active" },
      { onConflict: "coach_id,athlete_id" },
    );

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
