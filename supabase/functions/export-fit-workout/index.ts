// =============================================================================
//  Edge Function : export-fit-workout (22/09/2026)
//  ---------------------------------------------------------------------------
//  Garmin n'autorise pas une app tierce à pousser une séance sans partenariat ;
//  l'athlète importe le .FIT sur le SITE Garmin Connect (Entraînements >
//  Importer, puis « Envoyer vers l'appareil » — l'app mobile ne sait pas
//  importer), ou le copie en USB dans /Garmin/NewFiles ; Coros nécessite un partenariat approuvé pour
//  pousser une séance ; Polar n'expose pas d'API d'envoi. Le seul morceau
//  livrable sans dépendre d'un tiers : générer un vrai fichier .FIT
//  "workout" (structure officielle Garmin FIT SDK) que l'athlète charge
//  ensuite lui-même sur sa montre — voir OFFICIAL_FIT_FIELDS.md du SDK
//  (@garmin/fitsdk) pour les noms de champs utilisés ci-dessous.
//
//  Auth : JWT requis (juste pour éviter l'abus anonyme — la génération ne lit
//  ni n'écrit rien en base, la séance est fournie directement par l'appelant,
//  qui l'a déjà légitimement en main côté client).
//  Body : { session: { title, disc, blocks }, refs?: { ftp, vma, fcMax, … } }
//  (blocks = même forme que scheduled_sessions.blocks). Encodage : voir
//  _shared/fitWorkout.ts (corrigé et testé par aller-retour le 30/10/2026).
// =============================================================================
import { Encoder, Profile } from "npm:@garmin/fitsdk@21.214.0";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildFitWorkout, type FitRefs, type FitSession } from "../_shared/fitWorkout.ts";

function safeFileName(s: string): string {
  const ascii = (s || "seance").normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return ascii.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "seance";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const body = await req.json().catch(() => ({}));
    const session: FitSession | undefined = body.session;
    if (!session || !Array.isArray(session.blocks)) {
      return json({ error: "session (avec blocks) requis" }, 400);
    }
    // Références de l'athlète (FTP, VMA, FC max…) pour convertir les cibles en
    // zone en valeurs réelles ; envoyées par l'app, qui les a déjà chargées.
    const refs: FitRefs = (body.refs && typeof body.refs === "object") ? body.refs : {};

    const bytes = buildFitWorkout(session, refs, { Encoder, Profile });
    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFileName(session.title || "seance")}.fit"`,
      },
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur", detail: String(e).slice(0, 300) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
