// =============================================================================
//  Edge Function : coros-poll     (déployer avec --no-verify-jwt)
//  ---------------------------------------------------------------------------
//  Le serveur MCP COROS self-service N'A PAS de webhook → on tire les activités
//  et le bilan wellness de chaque athlète connecté sur planning.
//
//  Déclencheur : pg_cron toutes les ~2 h → POST avec header x-cron-secret
//  (même schéma que morning-digest / coach-alert-on-checkin).
//
//  Secrets : CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//            OAUTH_TOKEN_ENC_KEY  (+ COROS_MCP_BASE / COROS_MCP_CLIENT_ID facultatifs).
//
//  Prudence quota : COROS limite à 50 .fit/jour/compte. importRecent ne résout
//  qu'un petit lot d'URL .FIT par passe (withFit) et saute celles déjà connues.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { decryptConn } from "../_shared/tokenCrypto.ts";
import { importRecent, fetchWellness } from "../_shared/corosMcp.ts";
import { resolveActivityDuplicates } from "../_shared/activityDedup.ts";
import { sendEmail } from "../_shared/email.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Optionnel : ne traiter qu'un athlète (POST { user_id }) — utile pour un
  // "resync maintenant" déclenché depuis l'app sans exposer device-sync au cron.
  let onlyUser: string | null = null;
  try { onlyUser = (await req.json())?.user_id ?? null; } catch { /* pas de body */ }

  let q = sb.from("device_connections").select("*").eq("provider", "coros");
  if (onlyUser) q = q.eq("user_id", onlyUser);
  const { data: conns, error } = await q;
  if (error) return json({ error: error.message }, 500);

  let ok = 0, imported = 0, failed = 0;
  for (const row of conns ?? []) {
    const conn = await decryptConn(row);
    try {
      imported += await importRecent(sb, conn, 21, onlyUser ? 20 : 8);
      await fetchWellness(sb, conn);
      // Une montre déjà connectée gagne sur Strava — c'est ICI, pas au moment
      // de la connexion, que ça compte le plus (poll récurrent toutes les ~2h).
      try {
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        await resolveActivityDuplicates(sb, conn.user_id, since);
      } catch (e) { console.error("dedup:", conn.user_id, e); }
      ok++;
      if (row.meta?.sync_error || row.meta?.reconnect_mails) {
        await sb.from("device_connections")
          .update({ meta: { ...row.meta, sync_error: null, reconnect_mails: null, reconnect_mail_at: null } }).eq("id", row.id);
      }
    } catch (e) {
      failed++;
      const msg = String(e).slice(0, 300);
      console.error("coros-poll", conn.user_id, msg);
      // Garde la dernière erreur sur la connexion (lisible par le chien de garde et l'outil de gestion).
      // Le message COROS ne contient jamais le jeton : seulement le code HTTP et la réponse d'erreur OAuth.
      const meta: Record<string, unknown> = { ...(row.meta ?? {}), sync_error: { at: new Date().toISOString(), msg } };
      // Accès COROS définitivement perdu (jeton refusé ET expiré) : seul l'athlète peut se reconnecter.
      // On le prévient par e-mail : 1 fois tout de suite, 1 rappel 7 jours plus tard, puis plus rien.
      const expired = !row.expires_at || new Date(row.expires_at).getTime() < Date.now();
      if (expired && /invalid_grant|reconnexion requise/i.test(msg)) {
        const sent = Number(row.meta?.reconnect_mails ?? 0);
        const last = row.meta?.reconnect_mail_at ? new Date(row.meta.reconnect_mail_at).getTime() : 0;
        if (sent < 2 && Date.now() - last > 7 * 86400000) {
          try {
            const { data: p } = await sb.from("profiles").select("email, first_name, full_name").eq("id", row.user_id).maybeSingle();
            if (p?.email && await sendEmail({ to: p.email, subject: "Ta montre COROS n'est plus reliée à Sillance", html: reconnectHtml(p.first_name || p.full_name || "", sent > 0) })) {
              meta.reconnect_mails = sent + 1;
              meta.reconnect_mail_at = new Date().toISOString();
            }
          } catch (m) { console.error("coros-poll mail", row.user_id, String(m).slice(0, 200)); }
        }
      }
      await sb.from("device_connections").update({ meta }).eq("id", row.id);
    }
  }
  return json({ ok, imported, failed, total: conns?.length ?? 0 });
});

// E-mail à l'athlète : sa connexion COROS est morte, il doit cliquer une fois pour la refaire.
function reconnectHtml(name: string, reminder: boolean): string {
  const appUrl = (Deno.env.get("APP_URL") ?? "https://sillance.app").replace(/\/$/, "");
  const hello = name ? `Salut ${esc(name.split(" ")[0])} !` : "Salut !";
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720">
    <h2 style="font-weight:800">${reminder ? "Rappel : " : ""}ta montre COROS n'est plus reliée</h2>
    <p>${hello} Sillance ne reçoit plus tes activités COROS : l'autorisation donnée à Sillance a expiré côté COROS.</p>
    <p>Tant qu'elle n'est pas refaite, tes séances ne remontent plus et ton coach ne voit pas ce que tu as réalisé.</p>
    <p><b>Ça prend 30 secondes :</b> ouvre Sillance, puis dans la carte « Synchronisation », clique sur <b>Reconnecter Coros</b> et valide sur la page COROS.</p>
    <p style="margin:22px 0"><a href="${appUrl}/sillance-app.html" style="background:#0e7c8c;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">Reconnecter ma montre</a></p>
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Une fois reconnectée, Sillance renouvelle l'autorisation tout seul : tu n'auras plus à le refaire.
    ${reminder ? "C'est le dernier rappel que tu recevras à ce sujet." : "Si tu ne reconnectes pas, tu recevras un seul rappel dans 7 jours."}</p>
  </div>`;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
