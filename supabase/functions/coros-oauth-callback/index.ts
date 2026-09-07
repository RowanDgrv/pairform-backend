// =============================================================================
//  Edge Function : coros-oauth-callback   (déployer avec --no-verify-jwt)
//  Retour OAuth 2.1 du serveur MCP COROS → échange le code (PKCE), enregistre
//  la connexion, lance un import initial.
//  Le code_verifier PKCE est repris depuis oauth_states.meta (posé par
//  buildAuthUrl dans _shared/corosMcp.ts).
// =============================================================================
import { admin, appUrl, functionsBase } from "../_shared/providers.ts";
import { corosClientId, exchangeCode, importRecent, fetchWellness } from "../_shared/corosMcp.ts";
import { encryptToken, decryptConn } from "../_shared/tokenCrypto.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");
  const back = (p: string) => Response.redirect(`${appUrl()}/sillance-app.html?${p}`, 302);

  if (oauthErr) return back(`coros=error&reason=${encodeURIComponent(oauthErr)}`);
  if (!code || !state) return back("coros=error&reason=missing_params");

  try {
    const sb = admin();
    const { data: st } = await sb.from("oauth_states")
      .select("*").eq("state", state).eq("provider", "coros").maybeSingle();
    if (!st) return back("coros=error&reason=bad_state");
    await sb.from("oauth_states").delete().eq("state", state);

    const verifier = st.meta?.code_verifier;
    const redirectUri = st.meta?.redirect_uri ?? `${functionsBase()}/coros-oauth-callback`;
    if (!verifier) return back("coros=error&reason=missing_verifier");

    const clientId = await corosClientId(sb, redirectUri);
    const t = await exchangeCode(clientId, code, verifier, redirectUri);

    const now = Math.floor(Date.now() / 1000);
    const { data: connRow, error } = await sb.from("device_connections").upsert({
      user_id: st.user_id,
      provider: "coros",
      access_token: await encryptToken(t.access_token),
      refresh_token: await encryptToken(t.refresh_token ?? null),
      expires_at: t.expires_in ? new Date((now + Number(t.expires_in)) * 1000).toISOString() : null,
      scope: t.scope ?? null,
      meta: { redirect_uri: redirectUri, connected_via: "mcp" },
    }, { onConflict: "user_id,provider" }).select().single();
    if (error) throw error;
    const conn = await decryptConn(connRow);

    let imported = 0;
    try { imported = await importRecent(sb, conn); } catch (e) { console.error("coros import:", e); }
    try { await fetchWellness(sb, conn); } catch (e) { console.error("coros wellness:", e); }

    return back(`coros=connected&imported=${imported}`);
  } catch (e) {
    console.error(e);
    return back(`coros=error&reason=${encodeURIComponent(String(e).slice(0, 80))}`);
  }
});
