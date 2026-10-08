// =============================================================================
//  Edge Function : coros-activity-streams  (détail seconde-par-seconde à la demande)
//  Pendant de strava-activity-streams pour les activités importées via COROS.
//  Body : { activity_id }  (uuid de la ligne external_activities)
//  Auth : JWT requis, propriétaire uniquement.
//  Renvoie : { points, laps }  (cache : ne re-télécharge/parse le .fit que si
//             points est vide — le .fit lui-même n'est jamais re-téléchargé
//             une fois parsé avec succès).
//
//  Le .fit est déjà récupéré en amont par coros-poll (URL stockée dans
//  raw.fit_url, cf. _shared/corosMcp.ts importRecent) : cette fonction se
//  contente de le télécharger et de le décoder à la demande (pas à l'import,
//  pour ne pas payer le coût de parsing sur des activités jamais consultées).
//  Si l'URL cache a expiré (lien signé côté COROS), on en redemande une
//  fraîche via le MCP avant d'abandonner.
// =============================================================================
import { admin, corsHeaders, json, userFromReq } from "../_shared/providers.ts";
import { decryptConn } from "../_shared/tokenCrypto.ts";
import { validToken, mcpCall } from "../_shared/corosMcp.ts";
import { parseFitArrayBuffer } from "../_shared/fitParser.ts";

async function freshFitUrl(sb: any, userId: string, labelId: string, sportType: number | null): Promise<string | null> {
  if (sportType == null) return null;
  const { data: connRow } = await sb.from("device_connections")
    .select("*").eq("user_id", userId).eq("provider", "coros").maybeSingle();
  if (!connRow) return null;
  const conn = await decryptConn(connRow);
  const token = await validToken(sb, conn);
  const { text } = await mcpCall(token, "queryActivityFitFileDownloadUrls", { labelId, sportType });
  const u = text.match(/https?:\/\/\S+\.fit/i);
  return u ? u[0] : null;
}

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
    if (act.provider !== "coros") return json({ error: "Détail seconde-par-seconde disponible uniquement pour COROS via cette route" }, 400);

    if (act.points) return json({ points: act.points, laps: act.laps ?? [] });

    let fitUrl: string | null = act.raw?.fit_url ?? null;
    const labelId = act.provider_activity_id as string;
    const sportType = act.raw?.sportType ?? null;

    if (!fitUrl) {
      // Pas encore résolue par coros-poll (quota 50 .fit/jour atteint, ou
      // activité trop ancienne pour le lot courant) : on tente une résolution
      // à la demande plutôt que de forcer l'athlète à attendre le prochain poll.
      fitUrl = await freshFitUrl(sb, user.id, labelId, sportType);
      if (!fitUrl) return json({ error: "Fichier détaillé pas encore disponible côté COROS, réessaie dans quelques minutes" }, 404);
    }

    async function downloadAndParse(url: string) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fit download: ${res.status}`);
      const buf = await res.arrayBuffer();
      return parseFitArrayBuffer(buf);
    }

    let parsed;
    try {
      parsed = await downloadAndParse(fitUrl);
    } catch (e) {
      // Lien signé expiré ou invalide : une seule tentative de renouvellement.
      console.warn("coros-activity-streams: retry fit url", labelId, String(e).slice(0, 150));
      const retryUrl = await freshFitUrl(sb, user.id, labelId, sportType);
      if (!retryUrl) return json({ error: "Fichier .fit introuvable côté COROS" }, 404);
      parsed = await downloadAndParse(retryUrl);
      fitUrl = retryUrl;
    }

    const { points, laps } = parsed;
    await sb.from("external_activities")
      .update({ points, laps, raw: { ...act.raw, fit_url: fitUrl } })
      .eq("id", act.id);
    return json({ points, laps });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});
