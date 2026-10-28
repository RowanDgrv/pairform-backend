// =============================================================================
//  Traduit une séance Sillance (scheduled_sessions.blocks — le format du
//  créateur de séance : blocs à répéter, lignes avec cible en % d'une
//  référence physio OU en valeur exacte) vers un "course" structuré COROS
//  (sections/groupes d'intervalles, cf. createScheduledWorkout).
//  ---------------------------------------------------------------------------
//  Limites RÉELLES de l'API COROS (pas un choix Sillance) :
//   • sportType créable en structuré : 1=running, 2=cycling, 5=trail running
//     seulement. natation/renfo/hyrox → aucune séance structurée possible,
//     sessionToCorosCourse renvoie null (l'appelant doit alors proposer le
//     .FIT ou juste la description en texte).
//   • intensité : heart rate (bpm), pace (s/km), power (W) seulement — pas
//     de cadence ni de RPE comme cible structurée (repris dans la
//     description en texte, l'athlète le lit).
//   • un groupe d'intervalles n'accepte que des membres sectionType 2
//     (training) ou 3 (recovery) — warmup/cooldown restent des sections à
//     part, hors du groupe.
// =============================================================================

export interface AthleteRef {
  ftp?: number | null; pma?: number | null; cp_bike?: number | null;
  vma?: number | null; cv?: number | null; seuil_run?: number | null;
  css?: number | null; fc_max?: number | null;
}

type ModelUnit = "W" | "kmh" | "pace" | "pace100" | "bpm";
const MODEL_REF: Record<string, { field: keyof AthleteRef; unit: ModelUnit }> = {
  ftp: { field: "ftp", unit: "W" },
  pma: { field: "pma", unit: "W" },
  cpBike: { field: "cp_bike", unit: "W" },
  vma: { field: "vma", unit: "kmh" },
  cv: { field: "cv", unit: "kmh" },
  seuilRun: { field: "seuil_run", unit: "pace" },      // s/km déjà
  css: { field: "css", unit: "pace100" },              // s/100m — non poussé (natation)
  fc: { field: "fc_max", unit: "bpm" },
};

const SECTION_TYPE: Record<string, number> = { warmup: 1, exo: 2, contre: 3, recov: 3, cooldown: 4 };

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** % d'une référence physio → valeur physique dans l'unité du modèle. */
function resolveZoneValue(model: string, pct: number, ref: AthleteRef): { unit: ModelUnit; value: number } | null {
  const m = MODEL_REF[model];
  if (!m) return null;
  const base = ref[m.field];
  if (base == null || !Number.isFinite(Number(base))) return null;
  return { unit: m.unit, value: (Number(base) * pct) / 100 };
}

interface CorosIntensity {
  intensityType?: number;
  intensityValueStart?: number;
  intensityValueEnd?: number;
}

/** Cible d'intensité COROS pour une ligne, ou {} si aucune traduction fiable
 *  (cadence/RPE/allure vélo — l'athlète les lira dans la description). */
function lineIntensity(line: any, disc: string, ref: AthleteRef): CorosIntensity {
  if (line.mode === "exact" && line.exact) {
    const e = line.exact;
    if (e.kind === "power") {
      const center = Number(e.w) || 0, tol = Number(e.tol) || 0;
      return { intensityType: 4, intensityValueStart: clamp(center - tol, 10, 2000), intensityValueEnd: clamp(center + tol, 10, 2000) };
    }
    if (e.kind === "pace" && disc === "run") {
      const center = (Number(e.m) || 0) * 60 + (Number(e.s) || 0), tol = Number(e.tol) || 0;
      if (!center) return {};
      return { intensityType: 2, intensityValueStart: clamp(center - tol, 120, 1499), intensityValueEnd: clamp(center + tol, 120, 1499) };
    }
    // FC exacte en bpm (ajoutée au constructeur le 28/10/2026) : course ET vélo.
    if (e.kind === "hr") {
      const lo = Number(e.lo) || 0, hi = Number(e.hi) || lo;
      if (!lo) return {};
      return { intensityType: 1, intensityValueStart: clamp(Math.min(lo, hi), 30, 240), intensityValueEnd: clamp(Math.max(lo, hi), 30, 240) };
    }
    // Vitesse km/h en course → allure s/km (COROS n'a pas de cible vitesse).
    if (e.kind === "speed" && disc === "run") {
      const v = Number(e.kmh) || 0, tol = Number(e.tol) || 0;
      if (v <= 0) return {};
      const fast = Math.round(3600 / (v + tol)), slow = Math.round(3600 / Math.max(0.5, v - tol));
      return { intensityType: 2, intensityValueStart: clamp(fast, 120, 1499), intensityValueEnd: clamp(slow, 120, 1499) };
    }
    // speed (vélo)/cadence/rpe/time100/time : pas de cible structurée COROS.
    return {};
  }
  if (line.mode === "zone" && line.model) {
    // % ± tolérance du coach → plage (avant : une valeur unique, la marge
    // de tolérance était perdue et la montre bipait au moindre écart).
    const pct = Number(line.pct) || 100, tol = Math.max(0, Number(line.pctTol) || 0);
    const lo = resolveZoneValue(line.model, pct - tol, ref), hi = resolveZoneValue(line.model, pct + tol, ref);
    if (!lo || !hi) return {};
    const range = (a: number, b: number, min: number, max: number, t: number) =>
      ({ intensityType: t, intensityValueStart: clamp(Math.round(Math.min(a, b)), min, max), intensityValueEnd: clamp(Math.round(Math.max(a, b)), min, max) });
    if (lo.unit === "W") return range(lo.value, hi.value, 10, 2000, 4);
    if (lo.unit === "bpm") return range(lo.value, hi.value, 30, 240, 1);
    if (lo.unit === "kmh" && disc === "run") return range(3600 / hi.value, 3600 / lo.value, 120, 1499, 2);
    // seuil en allure (s/km) : un % plus haut = plus rapide = moins de secondes
    if (lo.unit === "pace" && disc === "run") return range(lo.value, hi.value, 120, 1499, 2);
    // pace100 (CSS natation) / kmh vélo (pas d'intensité vitesse côté COROS) : rien.
    return {};
  }
  return {};
}

function lineToSection(line: any, disc: string, ref: AthleteRef): any | null {
  if (line.type === "station") return null; // Hyrox : pas de traduction COROS
  let targetType = 4, targetValue: number | undefined;
  if (line.metric === "time") {
    targetType = 2;
    targetValue = (Number(line.dur?.h) || 0) * 3600 + (Number(line.dur?.m) || 0) * 60 + (Number(line.dur?.s) || 0);
    if (!targetValue) return null;
  } else if (line.metric === "dist") {
    targetType = 1;
    targetValue = Math.round(Number(line.dist) || 0);
    if (!targetValue) return null;
  } // 'reps' (renfo) : pas de cible temps/distance → free mode, targetValue omis
  const intensity = lineIntensity(line, disc, ref);
  return {
    sectionType: SECTION_TYPE[line.type] || 2,
    targetType,
    ...(targetValue != null ? { targetValue } : {}),
    ...intensity,
  };
}

/** Un bloc Sillance (series × lines) → 1+ sections COROS. Un bloc répété
 *  (series>1) dont TOUTES les lignes sont exo/contre devient un groupe
 *  d'intervalles ; sinon (échauffement/retour au calme, series=1) chaque
 *  ligne reste une section indépendante. */
function blockToSections(block: any, disc: string, ref: AthleteRef): any[] {
  const sections = (block.lines || []).map((l: any) => lineToSection(l, disc, ref)).filter(Boolean);
  if (!sections.length) return [];
  const series = Math.max(1, Math.min(20, Number(block.series) || 1));
  const canGroup = series > 1 && sections.every((s: any) => s.sectionType === 2 || s.sectionType === 3);
  if (canGroup) return [{ intervalGroup: true, repeats: series, sets: sections }];
  // series>1 sans grouper proprement (mélange warmup/cooldown) : on répète
  // les sections à plat plutôt que de violer la contrainte COROS sur `sets`.
  const flat: any[] = [];
  for (let i = 0; i < series; i++) flat.push(...sections);
  return flat;
}

export interface SillanceSessionForPush {
  disc: string;
  title?: string;
  desc?: string;
  blocks: any[]; // scheduled_sessions.blocks (= builderState.blocks)
}

/** null = discipline non poussable vers COROS (natation/renfo/hyrox) ou
 *  aucune section exploitable. */
export function sessionToCorosCourse(session: SillanceSessionForPush, ref: AthleteRef): { sportType: number; courseName: string; courseDescription: string; sections: any[] } | null {
  const sportType = session.disc === "run" ? 1 : session.disc === "bike" ? 2 : null;
  if (!sportType) return null;
  const sections = (session.blocks || []).flatMap((b: any) => blockToSections(b, session.disc, ref));
  if (!sections.length) return null;
  const plan = describe(session.blocks || []);
  const note = (session.desc || "").trim();
  return {
    sportType,
    courseName: (session.title || "Séance Sillance").slice(0, 100),
    // Lu par l'athlète dans l'app COROS : déroulé en clair + consigne du coach.
    courseDescription: ([note, plan].filter(Boolean).join("\n\n") || "Séance envoyée depuis Sillance.").slice(0, 800),
    sections,
  };
}

const TYPE_FR: Record<string, string> = { warmup: "Échauffement", exo: "Effort", contre: "Contre-effort", recov: "Récup", cooldown: "Retour au calme", educatif: "Éducatifs" };
const REF_FR: Record<string, string> = { ftp: "FTP", pma: "PMA", cpBike: "PC", vma: "VMA", cv: "VC", seuilRun: "allure seuil", css: "CSS", fc: "FC max" };
function durTxt(l: any): string {
  if (l.metric === "dist") { const d = Number(l.dist) || 0; return d >= 1000 ? `${+(d / 1000).toFixed(2)} km` : `${d} m`; }
  const t = (Number(l.dur?.h) || 0) * 3600 + (Number(l.dur?.m) || 0) * 60 + (Number(l.dur?.s) || 0);
  if (!t) return "";
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}` : s ? `${m}'${String(s).padStart(2, "0")}` : `${m} min`;
}
function tgtTxt(l: any): string {
  if (l.mode === "exact" && l.exact) {
    const e = l.exact;
    if (e.kind === "hr") return `${e.lo}-${e.hi} bpm`;
    if (e.kind === "power") return `${e.w} W`;
    if (e.kind === "pace") return `${e.m}'${String(e.s).padStart(2, "0")}/km`;
    if (e.kind === "speed") return `${e.kmh} km/h`;
    if (e.kind === "rpe") return `RPE ${e.rpe}`;
    return "";
  }
  if (l.mode === "zone" && l.model) return `${l.pct}${l.pctTol ? `±${l.pctTol}` : ""} % ${REF_FR[l.model] || l.model}`;
  return "";
}
function describe(blocks: any[]): string {
  return blocks.map((b: any) => {
    const lines = (b.lines || []).map((l: any) => [TYPE_FR[l.type] || "", durTxt(l), tgtTxt(l)].filter(Boolean).join(" "));
    const series = Number(b.series) || 1;
    return series > 1 ? `${series} x (${lines.join(" + ")})` : lines.join(", ");
  }).filter(Boolean).join("\n").slice(0, 700);
}
