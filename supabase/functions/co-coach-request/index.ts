// =============================================================================
//  Edge Function : co-coach-request
//  Un coach existant OU l'athlète lui-même demande l'ajout d'un coach
//  supplémentaire (par email + étiquette de rôle : Vélo, Course, Nutrition…).
//  Ne crée PAS le lien coach_athlete — juste la demande, à valider par
//  l'autre partie via co-coach-approve.
//  Body : { athleteId: string, coachEmail: string, roleLabel?: string }
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";

const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { athleteId, coachEmail, roleLabel } = await req.json();
    if (!athleteId || !coachEmail) return json({ error: "athleteId et coachEmail requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const email = String(coachEmail).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Email invalide" }, 400);

    // Qui est l'appelant vis-à-vis de cet athlète ? Détermine qui devra valider.
    let requestedByRole: "athlete" | "coach";
    if (user.id === athleteId) {
      requestedByRole = "athlete";
    } else {
      const { data: link } = await supabase.from("coach_athlete")
        .select("id").eq("coach_id", user.id).eq("athlete_id", athleteId).eq("status", "active").maybeSingle();
      if (!link) return json({ error: "Tu n'es pas coach de cet athlète" }, 403);
      requestedByRole = "coach";
    }

    // Empêche de redemander un coach déjà lié.
    const { data: existingProfile } = await supabase.from("profiles")
      .select("id").ilike("email", email).maybeSingle();
    if (existingProfile) {
      const { data: already } = await supabase.from("coach_athlete")
        .select("id").eq("coach_id", existingProfile.id).eq("athlete_id", athleteId).eq("status", "active").maybeSingle();
      if (already) return json({ error: "Ce coach est déjà lié à cet athlète" }, 409);
    }

    // Réutilise une demande pending existante pour ce couple (idempotent),
    // sinon en crée une nouvelle.
    const { data: pending } = await supabase.from("co_coach_requests")
      .select("*").eq("athlete_id", athleteId).ilike("coach_email", email).eq("status", "pending").maybeSingle();

    let row = pending;
    if (!row) {
      const { data: ins, error: insErr } = await supabase.from("co_coach_requests").insert({
        athlete_id: athleteId,
        coach_email: email,
        coach_id: existingProfile?.id ?? null,
        role_label: roleLabel || null,
        requested_by: user.id,
        requested_by_role: requestedByRole,
      }).select().single();
      if (insErr) throw insErr;
      row = ins;
    }

    // Notifie la partie qui doit valider.
    const { data: athleteProfile } = await supabase.from("profiles")
      .select("full_name, email").eq("id", athleteId).single();
    const { data: requesterProfile } = await supabase.from("profiles")
      .select("full_name").eq("id", user.id).single();

    let notifyTo: string | null = null;
    let notifyHtml = "";
    if (requestedByRole === "coach") {
      // l'athlète doit valider
      notifyTo = athleteProfile?.email ?? null;
      notifyHtml = coCoachEmailHtml({
        title: "Ton coach propose d'ajouter un coach",
        body: `${esc(requesterProfile?.full_name || "Ton coach")} propose d'ajouter ${esc(email)}` +
          `${roleLabel ? " comme " + esc(roleLabel) : ""} à ton équipe de coaching.`,
      });
    } else {
      // un coach existant de l'athlète doit valider — notifie tous les coachs actifs
      const { data: links } = await supabase.from("coach_athlete")
        .select("coach_id").eq("athlete_id", athleteId).eq("status", "active");
      const coachIds = (links ?? []).map((l) => l.coach_id);
      const { data: coachProfiles } = coachIds.length
        ? await supabase.from("profiles").select("email, full_name").in("id", coachIds)
        : { data: [] as { email: string; full_name: string }[] };
      for (const p of coachProfiles ?? []) {
        if (p?.email) {
          await sendEmail({
            to: p.email,
            subject: "Sillance — demande d'ajout de coach",
            html: coCoachEmailHtml({
              title: "Ton athlète propose d'ajouter un coach",
              body: `${esc(athleteProfile?.full_name || "Ton athlète")} propose d'ajouter ${esc(email)}` +
                `${roleLabel ? " comme " + esc(roleLabel) : ""} à son équipe de coaching.`,
            }),
          }).catch((e) => console.warn("email co-coach:", e));
        }
      }
    }
    if (notifyTo) {
      await sendEmail({ to: notifyTo, subject: "Sillance — demande d'ajout de coach", html: notifyHtml })
        .catch((e) => console.warn("email co-coach:", e));
    }

    return json({ ok: true, request: row });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function coCoachEmailHtml(opts: { title: string; body: string }): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#0f1720">
    <h2 style="font-weight:800;letter-spacing:.4px">Sillance</h2>
    <p><b>${opts.title}</b></p>
    <p>${opts.body}</p>
    <p style="font-size:12px;color:#6b7682">Ouvre l'app Sillance pour valider ou refuser.</p>
  </div>`;
}
function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
