// =============================================================================
//  Edge Function : device-connect  (démarre la connexion OAuth d'un objet)
//  Body : { provider: 'strava' | 'garmin' | 'coros' | ... }
//  Auth : JWT requis (athlète connecté).
//  Renvoie : { url } à ouvrir pour Strava, ou { pending, message } si la
//  plateforme n'est pas encore homologuée (Garmin/Coros).
// =============================================================================
import {
  admin, corsHeaders, json, userFromReq, OAUTH, functionsBase, randomState,
} from "../_shared/providers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = admin();
    const user = await userFromReq(sb, req);
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { provider } = await req.json();
    const cfg = OAUTH[provider];
    if (!cfg) return json({ error: `Plateforme inconnue : ${provider}` }, 400);

    if (!cfg.ready || !cfg.clientId()) {
      return json({
        pending: true,
        provider,
        message:
          `L'intégration ${provider} est en cours d'homologation (programme partenaire). ` +
          `Elle s'activera dès réception des accès développeur.`,
      });
    }

    // State unique relié à l'utilisateur (le callback n'a pas de JWT).
    const state = randomState();
    const { error } = await sb.from("oauth_states").insert({ state, user_id: user.id, provider });
    if (error) throw error;

    if (provider === "strava") {
      const redirectUri = `${functionsBase()}/strava-oauth-callback`;
      const url = `${cfg.authorizeUrl}?` + new URLSearchParams({
        client_id: cfg.clientId()!,
        redirect_uri: redirectUri,
        response_type: "code",
        approval_prompt: "auto",
        scope: cfg.scope,
        state,
      }).toString();
      return json({ url });
    }

    return json({ error: `Démarrage OAuth non implémenté pour ${provider}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
