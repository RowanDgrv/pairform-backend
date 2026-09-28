// =============================================================================
//  Edge Function : accept-club-invite
//  L'invité connecté accepte une invitation CLUB via son token. Crée la ligne
//  club_members (c'est ça qui manquait avant — l'ancien lien d'invitation ne
//  faisait qu'un coach_athlete perso, jamais un membre de club) et marque
//  l'invitation 'accepted'.
//  Body : { token: string }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { token } = await req.json();
    if (!token) return json({ error: "Token requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: invite } = await supabase
      .from("club_invitations").select("*").eq("token", token).maybeSingle();

    if (!invite) return json({ error: "Invitation introuvable" }, 404);
    if (invite.status !== "pending") return json({ error: "Invitation déjà traitée" }, 409);
    if (new Date(invite.expires_at) < new Date()) {
      await supabase.from("club_invitations").update({ status: "expired" }).eq("id", invite.id);
      return json({ error: "Invitation expirée" }, 410);
    }
    if (invite.email.toLowerCase() !== (user.email ?? "").toLowerCase()) {
      return json({ error: "Cette invitation est destinée à un autre email" }, 403);
    }

    // Déjà membre (invitation renvoyée après coup) ? Idempotent.
    const { data: existing } = await supabase
      .from("club_members").select("id").eq("club_id", invite.club_id)
      .eq("athlete_id", user.id).maybeSingle();

    let memberId = existing?.id;
    if (!memberId) {
      // display_name capturé à l'adhésion (pas seulement via le join profiles
      // au SELECT) : l'affichage marche même pour un membre inséré par un
      // autre chemin plus tard qui oublierait la policy de lecture profils.
      const { data: profile } = await supabase
        .from("profiles").select("full_name").eq("id", user.id).maybeSingle();
      const { data: member, error: memErr } = await supabase
        .from("club_members")
        .insert({
          club_id: invite.club_id, athlete_id: user.id, role: "member",
          display_name: profile?.full_name ?? null,
        })
        .select().single();
      if (memErr) throw memErr;
      memberId = member.id;
    }

    await supabase.from("club_invitations").update({
      status: "accepted", member_id: memberId, accepted_at: new Date().toISOString(),
    }).eq("id", invite.id);

    return json({ ok: true, club_id: invite.club_id, member_id: memberId });
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
