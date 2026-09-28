// =============================================================================
//  Edge Function : club-assign-coach
//  Le gérant du club assigne (ou réassigne / retire) un coach staff du club
//  à une adhésion "Coaching +" (club_memberships.tier='coach'). Ça crée /
//  déplace / révoque le lien coach_athlete correspondant — le coach voit
//  ensuite l'athlète dans SON interface coach habituelle, rien d'autre à
//  changer côté front (voir migration 0054).
//
//  Ne touche JAMAIS un coach_athlete personnel (source_club_membership_id
//  null) : seuls les liens nés d'une assignation club sont créés/révoqués ici.
//
//  Body : { membership_id: string, coach_id: string | null }
//  Auth : JWT Supabase. Autorisé au seul gérant du club de cette adhésion.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { membership_id, coach_id } = await req.json();
    if (!membership_id) return json({ error: "membership_id requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    // --- adhésion + club + autorisation --------------------------------------
    const { data: membership } = await supabase
      .from("club_memberships")
      .select("id, club_id, member_id, tier, assigned_coach_id, clubs:club_id(name, owner_id), club_members:member_id(athlete_id)")
      .eq("id", membership_id).single();
    if (!membership) return json({ error: "Adhésion introuvable" }, 404);
    if (membership.tier !== "coach") {
      return json({ error: "Seules les adhésions « Coaching + » se assignent à un coach" }, 400);
    }
    if (membership.clubs?.owner_id !== user.id) return json({ error: "Non autorisé" }, 403);

    const athleteId = membership.club_members?.athlete_id;
    if (!athleteId) {
      return json({ error: "Ce membre n'a pas encore de compte Sillance" }, 400);
    }

    // --- le nouveau coach doit être staff (role='coach') de CE club ----------
    if (coach_id) {
      const { data: isStaff } = await supabase.rpc("club_coach_is_staff", {
        p_club_id: membership.club_id, p_coach_id: coach_id,
      });
      if (!isStaff) return json({ error: "Ce compte n'est pas coach de ce club" }, 400);
    }

    const previousCoachId = membership.assigned_coach_id;

    // --- écrit l'assignation sur l'adhésion -----------------------------------
    const { error: updErr } = await supabase
      .from("club_memberships")
      .update({ assigned_coach_id: coach_id ?? null })
      .eq("id", membership_id);
    if (updErr) throw updErr;

    // --- révoque l'ancien lien coach_athlete s'il venait de CETTE adhésion ---
    if (previousCoachId && previousCoachId !== coach_id) {
      const { error: archErr } = await supabase
        .from("coach_athlete")
        .update({ status: "archived" })
        .eq("coach_id", previousCoachId)
        .eq("athlete_id", athleteId)
        .eq("source_club_membership_id", membership_id);
      if (archErr) console.error("Révocation ancien coach_athlete échouée :", archErr);
    }

    // --- crée / réactive le lien coach_athlete du nouveau coach ---------------
    if (coach_id) {
      const { data: existing } = await supabase
        .from("coach_athlete")
        .select("id, source_club_membership_id")
        .eq("coach_id", coach_id).eq("athlete_id", athleteId)
        .maybeSingle();

      if (!existing) {
        const { error: insErr } = await supabase.from("coach_athlete").insert({
          coach_id, athlete_id: athleteId, status: "active",
          role_label: `Club : ${membership.clubs?.name ?? ""}`.trim(),
          source_club_membership_id: membership_id,
        });
        if (insErr) throw insErr;
      } else {
        // Un lien perso préexistant (source_club_membership_id null) n'est
        // jamais reconverti en lien club — on se contente de s'assurer qu'il
        // est actif, sa provenance reste intacte.
        const { error: reactErr } = await supabase
          .from("coach_athlete")
          .update({
            status: "active",
            source_club_membership_id: existing.source_club_membership_id ?? membership_id,
          })
          .eq("id", existing.id);
        if (reactErr) throw reactErr;
      }
    }

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
