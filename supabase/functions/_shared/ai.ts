// =============================================================================
//  _shared/ai.ts — Assistant IA Sillance
//  Appelle Claude pour transformer un BILAN CHIFFRÉ (déjà calculé par l'app)
//  en verdict + recommandations de coach. Claude NE CALCULE RIEN : il ne reçoit
//  que des nombres déjà mesurés → réponses courtes, fiables, vérifiables.
//
//  Prompt caching : le system prompt (les rubriques) est identique à chaque
//  appel → marqué cache_control ephemeral. Sur des centaines de résumés, seul
//  le petit payload dynamique est facturé plein tarif. Voir le plan financier.
// =============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Sonnet 4.6 par défaut (qualité du verdict) ; surchargble via env pour Haiku.
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";

// ---- Les RUBRIQUES (système, mis en cache) ----------------------------------
export const SYSTEM_PROMPT = `Tu es l'assistant d'un coach d'endurance (triathlon, course, vélo, Hyrox).
On te fournit le BILAN CHIFFRÉ d'UNE séance d'un athlète : ce sont des mesures
DÉJÀ CALCULÉES. Tu ne dois JAMAIS inventer de chiffre ni recalculer : utilise
uniquement les valeurs du bilan. Ton rôle est de JUGER la séance par rapport à
SON OBJECTIF et de donner des recommandations actionnables, comme un bon coach.

Réponds en français, concis, ton de coach (tutoiement de l'athlète à la 3e
personne possible). Réponds STRICTEMENT en JSON valide, sans texte autour :
{
  "verdict": "oui" | "partiel" | "non",   // objectif de la séance tenu ?
  "headline": string,                       // 1 phrase de synthèse
  "bullets": [ { "status": "ok"|"warn"|"bad", "text": string } ],  // 2 à 4 constats chiffrés
  "recos": [ string ]                       // 0 à 3 recommandations concrètes (vide si rien à corriger)
}

RUBRIQUES selon le champ "type" (ou "objective") du bilan :

• endurance / Z2 (footing endurance fondamentale) :
  But = rester en zone aérobie. Vérifie timeInTarget (temps en Z2) et decouple.
  - decouple < 5 % ET beaucoup de temps en Z2 → "oui".
  - decouple ≥ 5 % ou trop hors Z2 → dérive, allure trop haute → recommander de
    ralentir (~10-15 s/km ou ~5 bpm) pour rester aérobie.

• seuil / LT1 (tempo, seuil aérobie) :
  But = tenir pile la bonne zone. decouple est le juge principal.
  - decouple < ~8 % → "oui", effort soutenable.
  - decouple trop fort → l'intensité dépassait le seuil → recaler la zone plus bas.

• vo2 / VMA (intervalles, VO2max) :
  But = atteindre les zones hautes. Regarde les pics FC des séries (hardReps.peakPct)
  vs FCmax.
  - pics ≥ 90-95 % FCmax → "oui".
  - pics trop bas → zone cible pas atteinte → recommander de RALLONGER les
    intervalles ou de RÉDUIRE la récup pour faire monter le cœur.
  - forte dégradation d'allure entre 1re et dernière série → réduire le volume.

• autre (natation, renforcement, récupération) :
  Pas de jugement sévère : résume les zones et la charge, "oui" par défaut.

Sois factuel : chaque bullet doit citer un chiffre du bilan.`;

export interface ClaudeSummary {
  verdict: string;
  headline: string;
  bullets: { status: string; text: string }[];
  recos: string[];
}

export async function summarize(bilan: unknown): Promise<{ summary: ClaudeSummary; model: string }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquant");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      // system en tableau → cache_control sur les rubriques (réutilisées à chaque appel)
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `Bilan chiffré de la séance (JSON) :\n${JSON.stringify(bilan)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  const summary = parseJson(text);
  return { summary, model: MODEL };
}

// ---- Synthèse HEBDOMADAIRE (07/10/2026) : même esprit que SYSTEM_PROMPT
// ci-dessus, mais sur une LISTE de séances déjà réalisées dans la semaine
// plutôt qu'une seule — juge l'adhérence et la répartition d'ensemble,
// pas chaque séance en détail (ce rôle reste à l'assistant par séance).
export const WEEK_SYSTEM_PROMPT = `Tu es l'assistant d'un coach d'endurance (triathlon, course, vélo, Hyrox).
On te fournit la LISTE des séances RÉALISÉES par un athlète sur UNE semaine :
titre, discipline, durée prévue/réalisée, TSS, zone cible, RPE si renseigné.
Ce sont des mesures DÉJÀ CALCULÉES, ne recalcule rien. Ton rôle est de juger la
semaine DANS SON ENSEMBLE (adhérence au plan, répartition de l'intensité,
cohérence de la charge) et de donner des recommandations pour la semaine
suivante, comme un bon coach qui relit sa semaine avant d'ajuster la suite.

Réponds en français, concis, ton de coach. Réponds STRICTEMENT en JSON
valide, sans texte autour, même forme que pour une séance :
{
  "verdict": "oui" | "partiel" | "non",   // la semaine s'est déroulée comme prévu ?
  "headline": string,                       // 1 phrase de synthèse de la semaine
  "bullets": [ { "status": "ok"|"warn"|"bad", "text": string } ],  // 2 à 5 constats chiffrés
  "recos": [ string ]                       // 0 à 3 recommandations pour la semaine suivante
}

Points à vérifier :
- Adhérence : nombre de séances réalisées vs prévues, écart de durée/TSS cumulé.
- Répartition : trop de séances dans la même zone/discipline ? un manque de
  récupération (RPE élevés enchaînés sans séance facile) ?
- Charge totale cohérente avec l'historique si donné, sinon juge sur la
  semaine seule.

Sois factuel : chaque bullet doit citer un chiffre de la liste fournie.`;

export async function summarizeWeek(
  sessions: unknown[],
): Promise<{ summary: ClaudeSummary; model: string }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquant");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: [
        { type: "text", text: WEEK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `Séances réalisées cette semaine (JSON) :\n${JSON.stringify(sessions)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  const summary = parseJson(text);
  return { summary, model: MODEL };
}

// Claude renvoie du JSON ; on tolère un éventuel bloc ```json … ```.
function parseJson(text: string): ClaudeSummary {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const obj = JSON.parse(t);
  return {
    verdict: String(obj.verdict ?? "partiel"),
    headline: String(obj.headline ?? ""),
    bullets: Array.isArray(obj.bullets) ? obj.bullets : [],
    recos: Array.isArray(obj.recos) ? obj.recos : [],
  };
}
