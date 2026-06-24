// =============================================================================
//  Edge Function : coros-oauth-callback  (déployer avec --no-verify-jwt)
//  Retour OAuth2 Coros → échange le code, enregistre la connexion, import initial.
// =============================================================================
import { admin, appUrl, functionsBase } from "../_shared/providers.ts";
import { corosExchangeCode, corosImportRecent } from "../_shared/coros.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");
  const back = (p: string) => Response.redirect(`${appUrl()}/?${p}`, 302);

  if (oauthErr) return back(`coros=error&reason=${encodeURIComponent(oauthErr)}`);
  if (!code || !state) return back("coros=error&reason=missing_params");

  try {
    const sb = admin();
    const { data: st } = await sb.from("oauth_states")
      .select("*").eq("state", state).eq("provider", "coros").maybeSingle();
    if (!st) return back("coros=error&reason=bad_state");
    await sb.from("oauth_states").delete().eq("state", state);

    const redirectUri = `${functionsBase()}/coros-oauth-callback`;
    const t = await corosExchangeCode(code, redirectUri);

    const now = Math.floor(Date.now() / 1000);
    const { data: conn, error } = await sb.from("device_connections").upsert({
      user_id: st.user_id,
      provider: "coros",
      provider_user_id: t.openId ?? t.userId ?? t.data?.openId ?? null,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? null,
      expires_at: t.expires_in ? new Date((now + Number(t.expires_in)) * 1000).toISOString() : null,
      scope: t.scope ?? null,
    }, { onConflict: "user_id,provider" }).select().single();
    if (error) throw error;

    let imported = 0;
    try { imported = await corosImportRecent(sb, conn); } catch (e) { console.error("import:", e); }
    return back(`coros=connected&imported=${imported}`);
  } catch (e) {
    console.error(e);
    return back(`coros=error&reason=${encodeURIComponent(String(e).slice(0, 80))}`);
  }
});
