// En-têtes CORS partagés par les edge functions.
// Durci : l'origine autorisée vient de la variable d'env CORS_ORIGIN (l'origine
// exacte du front, ex. https://rowandgrv.github.io ou le domaine custom en prod).
// On n'autorise QU'UNE origine explicite — pas de '*', pas de reflection
// arbitraire (la reflection mal faite est un grand classique de faille CORS).
// Pour le dev local, poser CORS_ORIGIN=http://localhost:5500.
const ALLOWED_ORIGIN = Deno.env.get("CORS_ORIGIN") ?? "https://rowandgrv.github.io";

export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
