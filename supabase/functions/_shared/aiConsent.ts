// Consentement de l'athlète à l'Assistant IA (0091, politique 3.9).
// Renvoie null si l'analyse est permise, sinon le code d'erreur à renvoyer :
//   athlete_ai_refused         → l'athlète a désactivé l'analyse IA
//   athlete_ai_consent_needed  → Garmin connecté sans « oui » explicite
// Le coach qui analyse SES propres séances (athleteId absent ou = lui) n'est
// pas bloqué : c'est lui qui déclenche l'analyse.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
export async function aiConsentBlock(supabase: any, coachId: string, athleteId: string | null): Promise<string | null> {
  if (!athleteId || athleteId === coachId || !UUID.test(athleteId)) return null;
  const { data: ap, error } = await supabase.from("athlete_profiles")
    .select("ai_consent").eq("user_id", athleteId).maybeSingle();
  if (error) throw error;
  if (ap?.ai_consent === false) return "athlete_ai_refused";
  if (ap?.ai_consent !== true) {
    const { data: g, error: gErr } = await supabase.from("device_connections")
      .select("id").eq("user_id", athleteId).eq("provider", "garmin").limit(1);
    if (gErr) throw gErr;
    if (g && g.length) return "athlete_ai_consent_needed";
  }
  return null;
}
