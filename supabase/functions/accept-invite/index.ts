// =============================================================================
//  Edge Function : accept-invite
//  L'athlète connecté accepte une invitation via son token. Crée le lien
//  coach_athlete et marque l'invitation 'accepted'.
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
      .from("invitations").select("*").eq("token", token).maybeSingle();

    if (!invite) return json({ error: "Invitation introuvable" }, 404);
    if (invite.status !== "pending") return json({ error: "Invitation déjà traitée" }, 409);
    if (new Date(invite.expires_at) < new Date()) {
      await supabase.from("invitations").update({ status: "expired" }).eq("id", invite.id);
      return json({ error: "Invitation expirée" }, 410);
    }
    // L'email de l'invitation doit correspondre au compte connecté.
    if (invite.email.toLowerCase() !== (user.email ?? "").toLowerCase()) {
      return json({ error: "Cette invitation est destinée à un autre email" }, 403);
    }

    // Crée le lien coach ↔ athlète (idempotent).
    await supabase.from("coach_athlete").upsert(
      { coach_id: invite.coach_id, athlete_id: user.id, status: "active" },
      { onConflict: "coach_id,athlete_id" },
    );

    await supabase.from("invitations").update({
      status: "accepted", athlete_id: user.id, accepted_at: new Date().toISOString(),
    }).eq("id", invite.id);

    return json({ ok: true, coach_id: invite.coach_id });
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
