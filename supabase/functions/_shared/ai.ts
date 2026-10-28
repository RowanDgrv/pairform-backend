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

// Fournisseurs (28/10/2026) : Groq en principal (offre gratuite, données ni
// conservées ni utilisées pour l'entraînement), Claude en repli. AI_PROVIDER
// = "anthropic" inverse l'ordre. Un fournisseur sans clé est simplement sauté.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile retiré de l'offre gratuite Groq le 16/08/2026 ;
// gpt-oss-120b est le remplaçant recommandé. Surchargeable sans redéployer.
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b";

// ---- Les RUBRIQUES (système, mis en cache) ----------------------------------
export const SYSTEM_PROMPT = `Tu es l'assistant d'un coach d'endurance (triathlon, course, vélo, Hyrox).
Seul le COACH lit ta réponse. On te fournit le BILAN CHIFFRÉ d'UNE séance
réalisée par un athlète, avec :
- "label" : le nom court de la séance prévue (ex. "Footing", "Séance seuil") ;
- "constats" : les écarts DÉJÀ DÉTECTÉS par l'app par rapport à la consigne
  ({texte, majeur}). Liste vide = consigne respectée.
Tu ne dois JAMAIS inventer de chiffre, de constat ou recalculer quoi que ce soit.

Ton seul travail : dire en UNE phrase courte si la séance demandée a été faite.
- "constats" vide → headline EXACTEMENT : "<label> respectant la cible."
  et verdict "oui".
- sinon → UNE phrase (25 mots max) qui commence par "<label> :" et dit ce qui
  n'a pas été, avec les chiffres des constats (trop rapide, accélération en
  pleine séance, dérive cardiaque, séries trop dures/trop faciles…). Si au moins
  un constat est "majeur", termine par "→ séance pas réalisée comme demandé."
  et verdict "non" ; sinon verdict "partiel".
- type "libre" (pas de consigne) → verdict "libre", headline factuelle sur la
  durée et la FC moyenne, sans jugement.
Pas de conseil, pas de formule de politesse, pas de jargon inutile.

Réponds en français, STRICTEMENT en JSON valide, sans texte autour :
{
  "verdict": "oui" | "partiel" | "non" | "libre",
  "headline": string,
  "bullets": [ { "status": "ok"|"warn"|"bad", "text": string } ],  // 0 à 3 chiffres clés du bilan, pour le détail replié
  "recos": []                                                       // toujours vide
}`;

export const REPORT_SYSTEM_PROMPT = `# RÔLE
Tu es un analyste de la performance en sports d'endurance (course à pied, trail, triathlon, vélo), au service d'un coach diplômé. Tu compares ce que l'athlète a RÉALISÉ à ce qui était PRÉVU, puis tu évalues son état de fatigue global. Tu es rigoureux, factuel et tu ne fais jamais de diagnostic médical.

# CE QUE TU REÇOIS
Un « dossier » JSON dont TOUS les chiffres ont DÉJÀ été calculés par l'application à partir des données de la montre :
- "profil" : sexe, âge, FC max, FC repos, zones de FC (en % de FC max), seuils, objectif ;
- "seance_prevue" : titre, discipline, durée, zone cible, structure des blocs ;
- "verification" : données présentes, manquantes, anomalies détectées, confiance globale ;
- "blocs_realises" : un objet par tour/bloc (durée, distance, allure ou vitesse, allure ajustée à la pente, FC moy/max, % FC max, % FC de réserve si FC repos connue, zone, régularité en coefficient de variation, cadence, dénivelé, puissance, série intense ou non) ;
- "frequence_cardiaque" : temps par zone, dérive cardiaque 1re vs 2e moitié (et si elle est interprétable), récupération après les séries ;
- "allure" : moyenne, 1re vs 2e moitié, split négatif, départ et fin vs corps de séance ;
- "cadence" : moyenne, 1er vs dernier tiers, au quart le plus lent vs le plus rapide ;
- "denivele" : D+, D-, D+ prévu, montées significatives avec VAM, FC et cadence ;
- "forme" : HRV (jour, moyenne 7 j et 28 j, référence), FC repos (jour, 7 j, référence), sommeil, fatigue déclarée, RPE, douleur ou indisponibilité, charge (CTL, ATL, TSB, ratio aigu/chronique), et le cycle menstruel UNIQUEMENT s'il est présent.

# RÈGLES ABSOLUES
1. N'utilise QUE les valeurs du dossier. Ne calcule rien de nouveau, n'invente aucune valeur, aucune norme, aucune moyenne « typique ». Une valeur absente ou égale à « donnée non disponible » s'écrit « donnée non disponible ».
2. Distingue toujours ce qui est MESURÉ (valeurs du dossier) de ce qui est INTERPRÉTÉ (ton analyse).
3. Pour chaque section, donne un niveau de confiance : « élevé », « moyen » ou « faible », selon la qualité des données (voir "verification").
4. Si la FC dépasse la FC max renseignée (voir anomalies), signale que la FC max est probablement sous-estimée.
5. Si une étape est impossible faute de données, mets une seule ligne dans "interpretation" qui le dit, et laisse "mesure" vide.
6. Pas de diagnostic médical. En cas de signe pouvant évoquer un surentraînement, une blessure ou un problème de santé (douleur déclarée, FC de repos anormalement haute plusieurs jours, chute durable de l'HRV), recommande de consulter un professionnel de santé.

# CE QUE TU PRODUIS, ÉTAPE PAR ÉTAPE
Étape 0, vérification : reprends présentes, manquantes et anomalies du dossier, et la confiance globale.
Étape 1, prévu vs réalisé : un tableau bloc par bloc (prévu, réalisé, écart chiffré, verdict parmi : respecté / trop rapide / trop lent / trop intense / trop facile / incomplet). Si la structure prévue ne permet pas d'aligner les blocs un à un, compare la séance dans son ensemble et dis-le. Donne un taux global de respect sous forme de phrase et explique les écarts significatifs (plus de 3 % d'allure ou changement de zone de FC).
Étape 2, fréquence cardiaque : % de FC max (et de réserve si fourni) par bloc, temps par zone vs zone ciblée, dérive cardiaque (plus de 5 % = signal d'endurance insuffisante, de chaleur, de déshydratation ou de fatigue ; ne l'interprète pas si "derive_interpretable" est faux), récupération entre les séries.
Étape 3, allure : régularité par bloc, gestion de l'effort (départ trop rapide, effondrement en fin, split négatif), allure ajustée à la pente en terrain vallonné.
Étape 4, cadence : moyenne et évolution avec la vitesse et la fatigue (baisse en fin = signal de fatigue musculaire ou de dégradation technique). Ne présente jamais 180 pas/min comme une règle.
Étape 5, dénivelé : VAM des montées, FC et cadence en montée vs sur le plat, écart avec le D+ prévu.
Étape 6, fatigue : croise HRV, FC repos, sommeil, fatigue déclarée, RPE vs intensité réelle et charge ; aucun indicateur seul. Le ratio aigu/chronique est à présenter à titre indicatif uniquement. Cycle menstruel : seulement s'il est fourni ; contextualise (en phase lutéale, FC et température peuvent être un peu plus hautes et l'HRV un peu plus basse) sans généraliser. Conclus par un indice : "vert" (frais), "jaune" (fatigue modérée) ou "rouge" (fatigue élevée), avec une justification chiffrée.
Étape 7, synthèse : résumé en 3 phrases, 3 points positifs maximum, 3 points d'attention maximum classés par priorité, recommandations concrètes (maintenir / alléger / ajuster les allures / revoir les zones / revoir la FC max), signaux d'alerte éventuels.

# FORME
Français clair, compréhensible par le coach et transmissible à l'athlète, chiffres à l'appui, sans jargon inutile. Réponds STRICTEMENT en JSON valide, sans texte autour, avec exactement cette structure :
{
  "verification": { "presentes": [string], "manquantes": [string], "anomalies": [string], "confiance": string },
  "prevu_vs_realise": { "blocs": [ { "bloc": string, "prevu": string, "realise": string, "ecart": string, "verdict": string } ], "taux_respect": string, "explication": string, "confiance": string },
  "frequence_cardiaque": { "mesure": [string], "interpretation": [string], "confiance": string },
  "allure": { "mesure": [string], "interpretation": [string], "confiance": string },
  "cadence": { "mesure": [string], "interpretation": [string], "confiance": string },
  "denivele": { "mesure": [string], "interpretation": [string], "confiance": string },
  "fatigue": { "indice": "vert" | "jaune" | "rouge", "mesure": [string], "interpretation": [string], "confiance": string },
  "synthese": { "resume": string, "positifs": [string], "attention": [string], "recommandations": [string], "alertes": [string] }
}
`;

export interface ClaudeSummary {
  verdict: string;
  headline: string;
  bullets: { status: string; text: string }[];
  recos: string[];
}

export async function summarize(bilan: unknown): Promise<{ summary: ClaudeSummary; model: string }> {
  return await generate(SYSTEM_PROMPT, `Bilan chiffré de la séance (JSON) :\n${JSON.stringify(bilan)}`, 1200);
}

// ---- Synthèse HEBDOMADAIRE (07/10/2026) : même esprit que SYSTEM_PROMPT
// ci-dessus, mais sur une LISTE de séances déjà réalisées dans la semaine
// plutôt qu'une seule — juge l'adhérence et la répartition d'ensemble,
// pas chaque séance en détail (ce rôle reste à l'assistant par séance).
export const WEEK_SYSTEM_PROMPT = `Tu es l'assistant d'un coach d'endurance (triathlon, course, vélo, Hyrox).
Seul le COACH lit ta réponse. On te fournit la semaine d'UN athlète en JSON :
- "bilan" : compteurs DÉJÀ CALCULÉS (séances prévues à date, réalisées, non
  réalisées, à venir, hors plan, durées prévue et réalisée en minutes) ;
- "fc_max_athlete" : sa fréquence cardiaque max de référence ;
- "seances" : chaque séance avec "statut" (réalisée / non réalisée / à venir /
  hors plan), "prevu" (titre, discipline, durée, zone cible, type), "realise"
  (durée, distance, FC moyenne, % de FC max, zone de la FC moyenne, RPE) et
  "constat" = l'écart DÉJÀ CALCULÉ entre prévu et réalisé.

RÈGLE ABSOLUE : n'utilise QUE des chiffres présents dans le JSON. N'invente
jamais de nombre de séances, de durée « typique », d'objectif ou de norme.
Ne recalcule rien : reprends les valeurs et le "constat" tels quels.

Ce que tu produis :
- "bullets" : UNE ligne par séance réalisée, non réalisée ou hors plan (ignore
  "à venir"), dans l'ordre des dates, au format :
  « <Titre prévu> : prévu <durée> min en <zone cible>, réalisé <durée> min à
  <pct_fc_max> % de FC max (<zone_fc_moy>) → <constat>. »
  Omets simplement une valeur absente. Non réalisée → « <Titre> : non réalisée. »
  Hors plan → « <Titre> (hors plan) : <durée> min à <pct_fc_max> % de FC max (<zone>). »
  status : "ok" si zone cible respectée, "warn" si écart de zone, séance
  fractionnée, FC absente ou hors plan, "bad" si non réalisée.
- "headline" : UNE phrase sur la semaine qui reprend les compteurs du "bilan"
  (ex. « 3 séances réalisées sur 4 prévues à date, zones d'endurance respectées. »).
- "verdict" : "oui" si toutes les séances prévues à date sont réalisées sans
  écart de zone ; "non" si moins de la moitié sont réalisées ; sinon "partiel".
- "recos" : 0 à 3 conseils courts pour la suite, chacun justifié par une
  ligne ci-dessus. Aucune reco générique.

Réponds en français, ton de coach, concis. STRICTEMENT en JSON valide, sans
texte autour :
{
  "verdict": "oui" | "partiel" | "non",
  "headline": string,
  "bullets": [ { "status": "ok"|"warn"|"bad", "text": string } ],
  "recos": [ string ]
}
`;

export async function summarizeWeek(
  sessions: unknown,
): Promise<{ summary: ClaudeSummary; model: string }> {
  return await generate(WEEK_SYSTEM_PROMPT, `Semaine de l'athlète (JSON) :\n${JSON.stringify(sessions)}`, 3000);
}

// ---- Appel multi-fournisseur ------------------------------------------------
type Provider = "groq" | "anthropic";
export interface AiAttempt { provider: Provider; model: string; error: string }
// Échec de TOUS les fournisseurs : garde le détail de chaque tentative, pour
// la fenêtre d'erreur côté app et l'email d'alerte (où et pourquoi ça a planté).
export class AiError extends Error {
  attempts: AiAttempt[];
  constructor(attempts: AiAttempt[]) {
    super(attempts.length ? attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ") : "Aucun fournisseur IA configuré");
    this.attempts = attempts;
  }
}

function providerOrder(): Provider[] {
  const order: Provider[] = (Deno.env.get("AI_PROVIDER") ?? "groq") === "anthropic"
    ? ["anthropic", "groq"] : ["groq", "anthropic"];
  return order.filter((p) => !!Deno.env.get(p === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY"));
}

async function generate(system: string, user: string, maxTokens: number): Promise<{ summary: ClaudeSummary; model: string }> {
  const { value, model } = await runProviders(system, user, maxTokens, (text) => {
    const summary = parseJson(text);
    if (!summary.headline) throw new Error("headline vide");
    return summary;
  });
  return { summary: value, model };
}

// Boucle fournisseurs générique : Groq puis Claude ; `parse` valide la sortie
// (une sortie illisible compte comme un échec et passe au fournisseur suivant).
async function runProviders<T>(system: string, user: string, maxTokens: number,
  parse: (text: string) => T): Promise<{ value: T; model: string }> {
  const attempts: AiAttempt[] = [];
  for (const p of providerOrder()) {
    const model = p === "groq" ? GROQ_MODEL : ANTHROPIC_MODEL;
    try {
      const text = p === "groq" ? await callGroq(system, user, maxTokens) : await callAnthropic(system, user, maxTokens);
      let value: T;
      try { value = parse(text); }
      catch (pe) { throw new Error(`bad_output: ${String((pe as Error)?.message ?? pe).slice(0, 80)} | ${text.slice(0, 160)}`); }
      return { value, model: `${p}:${model}` };
    } catch (e) {
      attempts.push({ provider: p, model, error: String((e as Error)?.message ?? e).slice(0, 600) });
    }
  }
  throw new AiError(attempts);
}

// ---- Rapport complet de séance (28/10/2026) ---------------------------------
// Consigne de Rowan (analyste performance, 7 étapes) adaptée : les chiffres
// sont DÉJÀ calculés par l'app (« dossier ») ; l'IA interprète et rédige.
export async function generateReport(dossier: unknown): Promise<{ report: Record<string, unknown>; model: string }> {
  const { value, model } = await runProviders(REPORT_SYSTEM_PROMPT,
    `Dossier de la séance (JSON, valeurs déjà calculées) :\n${JSON.stringify(dossier)}`, 8000,
    (text) => {
      let t = text.trim();
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) t = fence[1].trim();
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      if (a >= 0 && b > a) t = t.slice(a, b + 1);
      const obj = JSON.parse(t);
      if (!obj || typeof obj !== "object" || !obj.synthese) throw new Error("synthese absente");
      return obj as Record<string, unknown>;
    });
  return { report: value, model };
}


async function callGroq(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("GROQ_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      // gpt-oss raisonne avant de répondre : la marge de tokens couvre ce
      // raisonnement + le JSON. Tâche simple → effort faible (plus rapide).
      max_completion_tokens: maxTokens,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      // system en tableau → cache_control sur les rubriques (réutilisées à chaque appel)
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return data?.content?.[0]?.text ?? "";
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

// Cause lisible d'un échec IA, renvoyée au client (jamais la clé ni le
// prompt) : avant, tout finissait en « Erreur serveur » et rien ne
// permettait de savoir si c'était la clé, le crédit, le modèle ou la sortie
// (constat 28/10/2026 : 0 résumé jamais enregistré, add-on actif).
export function aiErrorDetail(e: unknown): string {
  if (e instanceof AiError) {
    if (!e.attempts.length) return "missing_key";
    return e.attempts.map((a) => attemptCode(a.error)).join("+");
  }
  return attemptCode(String((e as Error)?.message ?? e ?? ""));
}
function attemptCode(msg: string): string {
  const m = msg.match(/^(Anthropic|Groq) (\d{3}):\s*([\s\S]*)$/);
  if (m) {
    const who = m[1].toLowerCase(), status = m[2];
    if (/credit balance/i.test(m[3])) return `${who}_credit`;
    let type = "";
    try { const j = JSON.parse(m[3]); type = j?.error?.type ?? j?.error?.code ?? ""; } catch { /* corps tronqué */ }
    return `${who}_${status}${type ? "_" + type : ""}`;
  }
  if (/^bad_output/.test(msg)) return "bad_output";
  if (/timed out|TimeoutError|aborted/i.test(msg)) return "timeout";
  return "unknown";
}
