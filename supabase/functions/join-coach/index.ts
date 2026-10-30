// =============================================================================
//  Edge Function : join-coach (30/10/2026)
//  Lien d'équipe du coach (?coach=<token>, migration 0083), réutilisable.
//    { action: "peek", token }  sans compte : prénom du coach pour l'écran
//                               d'accueil (« Léa t'invite… »), rien d'autre.
//    { action: "join", token }  athlète connecté : crée le lien coach_athlete
//                               (idempotent). Aucun nom n'est copié : le nom
//                               affiché au coach est celui du profil de
//                               l'athlète (bug club Muret, cf. 0083).
// =============================================================================
import { admin, corsHeaders, json, userFromReq } from "../_shared/providers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const { action, token } = await req.json().catch(() => ({}));
    if (typeof token !== "string" || !/^[0-9a-f]{16,64}$/.test(token)) return json({ error: "invalid_link" }, 400);

    const { data: link } = await sb.from("coach_join_links").select("coach_id").eq("token", token).maybeSingle();
    if (!link) return json({ error: "invalid_link" }, 404);
    const { data: coach } = await sb.from("profiles").select("first_name, full_name, role").eq("id", link.coach_id).maybeSingle();
    if (!coach || coach.role !== "coach") return json({ error: "invalid_link" }, 404);
    const coachName = coach.first_name || (coach.full_name || "").split(" ")[0] || "Ton coach";

    if (action === "peek") return json({ ok: true, coach_name: coachName });

    if (action === "join") {
      const user = await userFromReq(sb, req);
      if (!user) return json({ error: "unauthenticated" }, 401);
      if (user.id === link.coach_id) return json({ error: "own_link", coach_name: coachName }, 409);
      const { data: existing } = await sb.from("coach_athlete").select("status")
        .eq("coach_id", link.coach_id).eq("athlete_id", user.id).maybeSingle();
      if (existing?.status === "active") return json({ ok: true, already: true, coach_name: coachName });
      const { error } = await sb.from("coach_athlete").upsert(
        { coach_id: link.coach_id, athlete_id: user.id, status: "active" },
        { onConflict: "coach_id,athlete_id" },
      );
      if (error) throw error;
      return json({ ok: true, coach_name: coachName });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
