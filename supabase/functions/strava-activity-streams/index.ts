// =============================================================================
//  Edge Function : strava-activity-streams  (détail seconde-par-seconde à la demande)
//  Body : { activity_id }  (uuid de la ligne external_activities, PAS l'id Strava)
//  Auth : JWT requis, propriétaire uniquement (jamais le coach — cf. conditions
//         Strava : les données d'un athlète ne sont réaffichables qu'à lui-même).
//  Renvoie : { points }  (cache : ne rappelle Strava que si points est vide)
// =============================================================================
import {
  admin, corsHeaders, json, userFromReq,
  stravaValidToken, stravaFetchActivityDetail, stravaFetchStreams, normalizeStravaStreams,
} from "../_shared/providers.ts";
import { decryptConn } from "../_shared/tokenCrypto.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { activity_id } = await req.json().catch(() => ({}));
    if (!activity_id) return json({ error: "activity_id requis" }, 400);

    const { data: act } = await sb.from("external_activities")
      .select("*").eq("id", activity_id).eq("user_id", user.id).maybeSingle();
    if (!act) return json({ error: "Activité introuvable" }, 404);
    if (act.provider !== "strava") return json({ error: "Détail seconde-par-seconde disponible uniquement pour Strava" }, 400);

    if (act.points) return json({ points: act.points });

    const { data: connRow } = await sb.from("device_connections")
      .select("*").eq("user_id", user.id).eq("provider", "strava").maybeSingle();
    if (!connRow) return json({ error: "Compte Strava non connecté" }, 404);
    const conn = await decryptConn(connRow);

    const token = await stravaValidToken(sb, conn);
    const [detail, streams] = await Promise.all([
      stravaFetchActivityDetail(token, act.provider_activity_id),
      stravaFetchStreams(token, act.provider_activity_id),
    ]);
    const points = normalizeStravaStreams(detail, streams, act.disc);

    await sb.from("external_activities").update({ points }).eq("id", act.id);
    return json({ points });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});
