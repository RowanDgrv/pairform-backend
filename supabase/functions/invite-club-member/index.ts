// =============================================================================
//  Edge Function : invite-club-member
//  Génère un lien d'invitation pour qu'un NOUVEAU membre rejoigne un club
//  (crée club_members à l'acceptation, cf. migration 0055 — le lien de
//  coaching perso ne le faisait jamais). N'envoie plus rien automatiquement
//  (ni email ni WhatsApp) : le gérant récupère le lien et l'envoie lui-même
//  par le canal de son choix (décision produit 28/09/2026).
//
//  Body : { club_id: string, email: string }
//  Auth : JWT Supabase. Réservé au gérant du club.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { club_id, email } = await req.json();
    if (!club_id || !email || !String(email).includes("@")) {
      return json({ error: "club_id et email valides requis" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: club } = await supabase
      .from("clubs").select("id, name, owner_id").eq("id", club_id).single();
    if (!club) return json({ error: "Club introuvable" }, 404);
    if (club.owner_id !== user.id) return json({ error: "Réservé au gérant du club" }, 403);

    const cleanEmail = String(email).toLowerCase().trim();

    // Déjà membre avec un compte lié à cet email ? Pas besoin d'invitation.
    const { data: existingProfile } = await supabase
      .from("profiles").select("id").ilike("email", cleanEmail).maybeSingle();
    if (existingProfile) {
      const { data: alreadyMember } = await supabase
        .from("club_members").select("id").eq("club_id", club_id)
        .eq("athlete_id", existingProfile.id).maybeSingle();
      if (alreadyMember) return json({ error: "Cette personne est déjà membre du club" }, 409);
    }

    // Réutilise une invite pending existante pour ce couple club/email, sinon crée.
    const { data: invite, error } = await supabase
      .from("club_invitations")
      .upsert(
        { club_id, email: cleanEmail, status: "pending", invited_by: user.id },
        { onConflict: "club_id,email", ignoreDuplicates: false },
      )
      .select().single();

    let row = invite;
    if (error) {
      const { data: ins, error: insErr } = await supabase
        .from("club_invitations")
        .insert({ club_id, email: cleanEmail, invited_by: user.id })
        .select().single();
      if (insErr) throw insErr;
      row = ins;
    }

    const inviteUrl = `${Deno.env.get("APP_URL") ?? "http://localhost:5500"}/sillance-app.html?club_invite=${row.token}`;

    return json({ invite: row, inviteUrl });
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
