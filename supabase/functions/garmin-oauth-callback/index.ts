// =============================================================================
//  Edge Function : garmin-oauth-callback  (déployer avec --no-verify-jwt)
//  Garmin redirige le navigateur avec ?oauth_token=...&oauth_verifier=...
//  On échange contre le jeton d'accès, on enregistre la connexion, import initial.
// =============================================================================
import { admin, appUrl } from "../_shared/providers.ts";
import { garminAccessToken, garminUserId, garminImportRecent } from "../_shared/garmin.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const oauthToken = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  const back = (p: string) => Response.redirect(`${appUrl()}/?${p}`, 302);

  if (!oauthToken || !verifier) return back("garmin=error&reason=missing_params");

  try {
    const sb = admin();
    // Le request token sert de clé d'état (déposé par device-connect).
    const { data: st } = await sb.from("oauth_states")
      .select("*").eq("state", oauthToken).eq("provider", "garmin").maybeSingle();
    if (!st) return back("garmin=error&reason=bad_state");
    await sb.from("oauth_states").delete().eq("state", oauthToken);

    const reqSecret = st.meta?.req_secret ?? "";
    const acc = await garminAccessToken(oauthToken, reqSecret, verifier);
    const userId = await garminUserId(acc.token, acc.secret);

    const { data: conn, error } = await sb.from("device_connections").upsert({
      user_id: st.user_id,
      provider: "garmin",
      provider_user_id: userId,
      access_token: acc.token,
      token_secret: acc.secret,
    }, { onConflict: "user_id,provider" }).select().single();
    if (error) throw error;

    let imported = 0;
    try { imported = await garminImportRecent(sb, conn); } catch (e) { console.error("import:", e); }
    return back(`garmin=connected&imported=${imported}`);
  } catch (e) {
    console.error(e);
    return back(`garmin=error&reason=${encodeURIComponent(String(e).slice(0, 80))}`);
  }
});
