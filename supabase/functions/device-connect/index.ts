// =============================================================================
//  Edge Function : device-connect  (démarre la connexion OAuth d'un objet)
//  Body : { provider: 'strava' | 'coros' | 'garmin' | ... }
//  Auth : JWT requis (athlète connecté).
//  Renvoie : { url } à ouvrir, ou { pending, message } si les clés partenaire
//  de la plateforme ne sont pas encore configurées.
// =============================================================================
import {
  admin, corsHeaders, json, userFromReq, OAUTH, functionsBase, randomState,
} from "../_shared/providers.ts";
import { GARMIN, garminRequestToken } from "../_shared/garmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { provider } = await req.json();

    const pending = (msg?: string) => json({
      pending: true, provider,
      message: msg ?? `L'intégration ${provider} est en cours d'homologation ` +
        `(programme partenaire). Elle s'activera dès réception des accès développeur.`,
    });

    // ----- Garmin : OAuth 1.0a (request token → URL d'autorisation) -----
    if (provider === "garmin") {
      if (!GARMIN.ready()) return pending();
      const callback = `${functionsBase()}/garmin-oauth-callback`;
      const { token, secret } = await garminRequestToken(callback);
      const { error } = await sb.from("oauth_states")
        .insert({ state: token, user_id: user.id, provider: "garmin", meta: { req_secret: secret } });
      if (error) throw error;
      return json({ url: `${GARMIN.authorizeUrl}?oauth_token=${encodeURIComponent(token)}` });
    }

    // ----- Strava & Coros : OAuth2 « authorization code » -----
    const cfg = OAUTH[provider];
    if (!cfg) return json({ error: `Plateforme inconnue : ${provider}` }, 400);
    if (!cfg.ready || !cfg.clientId()) return pending();

    const state = randomState();
    const { error } = await sb.from("oauth_states").insert({ state, user_id: user.id, provider });
    if (error) throw error;

    const redirectUri = `${functionsBase()}/${provider}-oauth-callback`;
    const params: Record<string, string> = {
      client_id: cfg.clientId()!,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
    };
    if (provider === "strava") { params.approval_prompt = "auto"; params.scope = cfg.scope; }
    if (provider === "coros" && cfg.scope) params.scope = cfg.scope;
    return json({ url: `${cfg.authorizeUrl}?` + new URLSearchParams(params).toString() });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
