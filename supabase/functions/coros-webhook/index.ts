// =============================================================================
//  Edge Function : coros-webhook   — DÉSACTIVÉE
//  ---------------------------------------------------------------------------
//  Le serveur MCP COROS self-service ne fournit PAS de push/webhook (réservé au
//  palier "platforms operating at scale", onboardé manuellement par COROS).
//  La synchro passe donc par un tirage programmé : voir `coros-poll`.
//
//  Endpoint conservé (au cas où l'onboarding "at scale" réactive un webhook)
//  mais inerte : il ne fait rien et répond 410.
// =============================================================================
Deno.serve(() =>
  new Response(
    JSON.stringify({ message: "coros webhook disabled — sync via coros-poll (MCP self-service, no push)" }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
