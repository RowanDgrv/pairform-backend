// =============================================================================
//  Edge Function : intervals-oauth-callback   (déployer avec --no-verify-jwt)
//  ---------------------------------------------------------------------------
//  intervals.icu redirige le NAVIGATEUR ici après autorisation (donc pas de
//  JWT). On échange le code contre un Bearer, on enregistre la connexion, on
//  fait un import initial, puis on renvoie vers l'app.
//  Query : ?code=...&state=...   (ou ?error=access_denied)
//  Rappel : pas de refresh token côté intervals.icu — le Bearer ne périme pas.
// =============================================================================
import { admin, appUrl } from "../_shared/providers.ts";
import { intervalsExchangeCode, intervalsImportRecent } from "../_shared/intervals.ts";
import { encryptToken, decryptConn } from "../_shared/tokenCrypto.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");
  const back = (p: string) =>
    Response.redirect(`${appUrl()}/sillance-app.html?${p}`, 302);

  if (oauthErr) return back(`intervals=error&reason=${encodeURIComponent(oauthErr)}`);
  if (!code || !state) return back("intervals=error&reason=missing_params");

  try {
    const sb = admin();

    const { data: st } = await sb.from("oauth_states")
      .select("*").eq("state", state).eq("provider", "intervals").maybeSingle();
    if (!st) return back("intervals=error&reason=bad_state");
    await sb.from("oauth_states").delete().eq("state", state);

    const t = await intervalsExchangeCode(code);

    const { data: connRow, error } = await sb.from("device_connections").upsert({
      user_id: st.user_id,
      provider: "intervals",
      provider_user_id: t.athlete?.id ? String(t.athlete.id) : null,
      access_token: await encryptToken(t.access_token),
      refresh_token: null,
      expires_at: null,
      scope: t.scope ?? null,
    }, { onConflict: "user_id,provider" }).select().single();
    if (error) throw error;
    const conn = await decryptConn(connRow);

    // Import initial (best-effort — ne bloque pas le retour vers l'app).
    let imported = 0;
    try { imported = await intervalsImportRecent(sb, conn); }
    catch (e) { console.error("import:", e); }

    return back(`intervals=connected&imported=${imported}`);
  } catch (e) {
    console.error(e);
    return back(`intervals=error&reason=${encodeURIComponent(String(e).slice(0, 80))}`);
  }
});
