// =============================================================================
//  Edge Function : co-coach-approve
//  La partie qui N'A PAS initié la demande (l'athlète si un coach a demandé,
//  un coach existant de l'athlète si c'est l'athlète qui a demandé) valide ou
//  refuse. Si approuvé : crée le lien coach_athlete (le coach visé doit déjà
//  avoir un compte Sillance — sinon message clair, pas d'onboarding par email
//  pour les coachs en v1).
//  Body : { requestId: string, decision: 'approve' | 'decline' }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { requestId, decision } = await req.json();
    if (!requestId || !["approve", "decline"].includes(decision)) {
      return json({ error: "requestId et decision ('approve'|'decline') requis" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: reqRow } = await supabase.from("co_coach_requests")
      .select("*").eq("id", requestId).maybeSingle();
    if (!reqRow) return json({ error: "Demande introuvable" }, 404);
    if (reqRow.status !== "pending") return json({ error: "Demande déjà traitée" }, 409);
    if (new Date(reqRow.expires_at) < new Date()) {
      await supabase.from("co_coach_requests").update({ status: "expired" }).eq("id", reqRow.id);
      return json({ error: "Demande expirée" }, 410);
    }

    // Seule "l'autre partie" peut valider : celui qui n'a PAS initié la demande.
    let authorized = false;
    if (reqRow.requested_by_role === "coach") {
      authorized = user.id === reqRow.athlete_id;
    } else {
      const { data: link } = await supabase.from("coach_athlete")
        .select("id").eq("coach_id", user.id).eq("athlete_id", reqRow.athlete_id).eq("status", "active").maybeSingle();
      authorized = !!link;
    }
    if (!authorized) return json({ error: "Tu ne peux pas valider cette demande" }, 403);

    if (decision === "decline") {
      await supabase.from("co_coach_requests")
        .update({ status: "declined", resolved_at: new Date().toISOString(), approved_by: user.id })
        .eq("id", reqRow.id);
      return json({ ok: true, status: "declined" });
    }

    // Approbation : le coach visé doit avoir un compte Sillance existant.
    const { data: coachProfile } = await supabase.from("profiles")
      .select("id, role").ilike("email", reqRow.coach_email).maybeSingle();
    if (!coachProfile) {
      return json({ error: "Ce coach doit d'abord créer un compte Sillance avant de pouvoir être ajouté." }, 404);
    }
    if (coachProfile.role !== "coach") {
      return json({ error: "Cet email correspond à un compte qui n'est pas un compte coach." }, 400);
    }

    await supabase.from("coach_athlete").upsert(
      { coach_id: coachProfile.id, athlete_id: reqRow.athlete_id, status: "active", role_label: reqRow.role_label },
      { onConflict: "coach_id,athlete_id" },
    );
    await supabase.from("co_coach_requests").update({
      status: "approved", resolved_at: new Date().toISOString(), approved_by: user.id, coach_id: coachProfile.id,
    }).eq("id", reqRow.id);

    return json({ ok: true, status: "approved", coach_id: coachProfile.id });
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
