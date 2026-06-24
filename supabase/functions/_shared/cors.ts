// En-têtes CORS partagés par les edge functions.
// En prod, remplace '*' par l'origine de ton front (ex: https://app.pairform.xxx).
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
