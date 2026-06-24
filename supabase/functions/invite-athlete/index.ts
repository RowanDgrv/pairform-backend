// =============================================================================
//  Edge Function : invite-athlete
//  Un coach invite un athlète par email. Crée une ligne `invitations` avec un
//  token, envoie l'email d'invitation (Resend) et renvoie le lien.
//  Body : { email: string }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail, inviteEmailHtml } from "../_shared/email.ts";

const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { email } = await req.json();
    if (!email) return json({ error: "Email requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    // Vérifie que l'appelant est bien coach.
    const { data: me } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).single();
    if (me?.role !== "coach") return json({ error: "Réservé aux coachs" }, 403);

    // Réutilise une invite pending existante pour ce couple coach/email, sinon crée.
    const { data: invite, error } = await supabase
      .from("invitations")
      .upsert(
        { coach_id: user.id, email: email.toLowerCase(), status: "pending" },
        { onConflict: "coach_id,email", ignoreDuplicates: false },
      )
      .select()
      .single();

    // upsert sur (coach_id,email) nécessite une contrainte unique ; si absente,
    // on retombe sur un simple insert.
    let row = invite;
    if (error) {
      const { data: ins, error: insErr } = await supabase
        .from("invitations")
        .insert({ coach_id: user.id, email: email.toLowerCase() })
        .select().single();
      if (insErr) throw insErr;
      row = ins;
    }

    const inviteUrl = `${APP_URL}/?invite=${row.token}`;

    // Envoi de l'email (Resend). Si la clé n'est pas configurée, `emailed`=false
    // et le coach partage le lien manuellement — le flux reste fonctionnel.
    const coachName = me?.full_name || "Ton coach";
    let emailed = false;
    try {
      emailed = await sendEmail({
        to: email,
        subject: `${coachName} t'invite sur PairForm`,
        html: inviteEmailHtml({ coachName, inviteUrl }),
      });
    } catch (e) { console.error("email:", e); }

    return json({ invite: row, inviteUrl, emailed });
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
