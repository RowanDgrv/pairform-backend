// =============================================================================
//  Edge Function : strava-oauth-callback
//  Strava redirige le NAVIGATEUR ici après autorisation (donc pas de JWT —
//  déployer avec `--no-verify-jwt`). On échange le code, on enregistre la
//  connexion, on importe les activités récentes, puis on renredirige vers l'app.
//  Query : ?code=...&state=...  (ou ?error=access_denied)
// =============================================================================
import {
  admin, appUrl, stravaExchangeCode, stravaImportRecent,
} from "../_shared/providers.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");

  const back = (params: string) => Response.redirect(`${appUrl()}/?${params}`, 302);

  if (oauthErr) return back(`strava=error&reason=${encodeURIComponent(oauthErr)}`);
  if (!code || !state) return back("strava=error&reason=missing_params");

  try {
    const sb = admin();

    // Résout le state → utilisateur, puis le consomme.
    const { data: st } = await sb.from("oauth_states")
      .select("*").eq("state", state).eq("provider", "strava").maybeSingle();
    if (!st) return back("strava=error&reason=bad_state");
    await sb.from("oauth_states").delete().eq("state", state);

    // Échange le code contre des jetons (+ infos athlète).
    const t = await stravaExchangeCode(code);

    const { data: conn, error } = await sb.from("device_connections").upsert({
      user_id: st.user_id,
      provider: "strava",
      provider_user_id: t.athlete?.id ? String(t.athlete.id) : null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
      scope: t.scope ?? null,
    }, { onConflict: "user_id,provider" }).select().single();
    if (error) throw error;

    // Import initial (best-effort — ne bloque pas le retour si ça échoue).
    let imported = 0;
    try { imported = await stravaImportRecent(sb, conn); } catch (e) { console.error("import:", e); }

    return back(`strava=connected&imported=${imported}`);
  } catch (e) {
    console.error(e);
    return back(`strava=error&reason=${encodeURIComponent(String(e).slice(0, 80))}`);
  }
});
