// =============================================================================
//  Edge Function : push-session-to-watch
//  ---------------------------------------------------------------------------
//  Pousse UNE séance déjà planifiée (scheduled_sessions) vers la montre
//  connectée de L'ATHLÈTE concerné (pas forcément l'appelant — un coach peut
//  déclencher l'envoi pour son athlète, la séance atterrit sur SA montre).
//  Seul COROS est câblé pour l'instant (Polar/Garmin n'ont pas d'écriture
//  self-service côté API) — provider ignoré pour l'instant, réservé à Polar
//  quand cette écriture existera.
//
//  Body : { scheduled_session_id: string, date?: string (YYYY-MM-DD, sinon
//           la date de la séance) }
//  Auth : JWT — l'athlète lui-même, son coach personnel, ou un coach/admin
//         du même club (mêmes règles que club_coach_manages/is_coach_of,
//         réimplémentées ici car ce endpoint tourne en service_role, pas de
//         contexte auth.uid() pour les fonctions SQL qui s'appuient dessus).
// =============================================================================
import { admin, corsHeaders, json, userFromReq } from "../_shared/providers.ts";
import { decryptConn } from "../_shared/tokenCrypto.ts";
import { pushPlannedSession } from "../_shared/corosMcp.ts";

async function canManage(sb: ReturnType<typeof admin>, callerId: string, athleteId: string): Promise<boolean> {
  if (callerId === athleteId) return true;
  const { data: ca } = await sb.from("coach_athlete").select("id")
    .eq("coach_id", callerId).eq("athlete_id", athleteId).eq("status", "active").maybeSingle();
  if (ca) return true;
  const { data: staffRows } = await sb.from("club_members").select("club_id")
    .eq("athlete_id", callerId).in("role", ["coach", "admin"]);
  const clubIds = (staffRows ?? []).map((r: any) => r.club_id);
  if (!clubIds.length) return false;
  const { data: member } = await sb.from("club_members").select("id")
    .eq("athlete_id", athleteId).in("club_id", clubIds).maybeSingle();
  return !!member;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { scheduled_session_id, date } = await req.json().catch(() => ({}));
    if (!scheduled_session_id) return json({ error: "scheduled_session_id requis" }, 400);

    const { data: session, error: sessErr } = await sb.from("scheduled_sessions")
      .select("id, athlete_id, date, disc, title, blocks, coach_note").eq("id", scheduled_session_id).maybeSingle();
    if (sessErr || !session) return json({ error: "Séance introuvable" }, 404);

    if (!(await canManage(sb, user.id, session.athlete_id))) {
      return json({ error: "Pas les droits sur cette séance" }, 403);
    }

    // Codes d'erreur stables (no_coros, polar_unsupported, past_date,
    // unsupported_sport, empty_session, coros_auth, coros_rejected) : le
    // front affiche un message clair au lieu de télécharger un fichier.
    const { data: conns } = await sb.from("device_connections")
      .select("*").eq("user_id", session.athlete_id);
    const connRow = (conns ?? []).find((c: any) => c.provider === "coros");
    if (!connRow) {
      const hasPolar = (conns ?? []).some((c: any) => c.provider === "polar");
      return json({ error: hasPolar ? "polar_unsupported" : "no_coros" }, 409);
    }
    const target = date || session.date;
    const parisToday = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
    if (target < parisToday) return json({ error: "past_date" }, 409);
    if (session.disc !== "run" && session.disc !== "bike") return json({ error: "unsupported_sport", disc: session.disc }, 409);
    const conn = await decryptConn(connRow);

    const { data: ref } = await sb.from("athlete_profiles")
      .select("ftp, pma, cp_bike, vma, cv, seuil_run, css, fc_max").eq("user_id", session.athlete_id).maybeSingle();

    try {
      const result = await pushPlannedSession(
        sb, conn,
        { disc: session.disc, title: session.title, desc: session.coach_note || "", blocks: session.blocks || [] },
        target,
        ref || {},
      );
      return json(result);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      console.error("push-session-to-watch:", msg);
      const code = /séance structurée|aucune section/i.test(msg) ? "empty_session"
        : /401|403|token|refresh|invalid_grant|unauthor/i.test(msg) ? "coros_auth" : "coros_rejected";
      return json({ error: code, detail: msg.slice(0, 300) }, 502);
    }
  } catch (e) {
    console.error(e);
    return json({ error: "server", detail: String(e).slice(0, 300) }, 500);
  }
});
