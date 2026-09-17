// =============================================================================
//  Edge Function : polar-oauth-callback
//  Polar redirige le NAVIGATEUR ici après autorisation (donc pas de JWT —
//  déployer avec `--no-verify-jwt`). Client "V4" (auth.polar.com). Spécificités
//  Polar vs Strava : échange de code en Basic Auth (polarExchangeCode), pas en
//  JSON ; jeton valable 12 h + refresh_token stocké pour les syncs suivantes.
//  Query : ?code=...&state=...  (ou ?error=access_denied)
// =============================================================================
import {
  admin, appUrl, functionsBase, polarExchangeCode, polarRegisterUser, polarImportRecent,
} from "../_shared/providers.ts";
import { encryptToken, decryptConn } from "../_shared/tokenCrypto.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");

  const back = (params: string) => Response.redirect(`${appUrl()}/sillance-app.html?${params}`, 302);

  if (oauthErr) return back(`polar=error&reason=${encodeURIComponent(oauthErr)}`);
  if (!code || !state) return back("polar=error&reason=missing_params");

  try {
    const sb = admin();

    const { data: st } = await sb.from("oauth_states")
      .select("*").eq("state", state).eq("provider", "polar").maybeSingle();
    if (!st) return back("polar=error&reason=bad_state");
    await sb.from("oauth_states").delete().eq("state", state);

    const redirectUri = `${functionsBase()}/polar-oauth-callback`;
    const t = await polarExchangeCode(code, redirectUri);

    // Enregistrement obligatoire côté Polar (best-effort si déjà fait : 409 ignoré).
    try { await polarRegisterUser(t.access_token, st.user_id); } catch (e) { console.error("polar register:", e); }

    const { data: connRow, error } = await sb.from("device_connections").upsert({
      user_id: st.user_id,
      provider: "polar",
      provider_user_id: t.x_user_id ? String(t.x_user_id) : null,
      access_token: await encryptToken(t.access_token),
      refresh_token: await encryptToken(t.refresh_token ?? null), // fourni en V4 (jeton 12h)
      expires_at: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : null,
      scope: null,
    }, { onConflict: "user_id,provider" }).select().single();
    if (error) throw error;
    const conn = await decryptConn(connRow);

    let imported = 0;
    try { imported = await polarImportRecent(sb, conn); } catch (e) { console.error("polar import:", e); }

    return back(`polar=connected&imported=${imported}`);
  } catch (e) {
    console.error(e);
    return back(`polar=error&reason=${encodeURIComponent(String(e).slice(0, 80))}`);
  }
});
