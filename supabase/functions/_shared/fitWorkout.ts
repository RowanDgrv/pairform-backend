// =============================================================================
//  _shared/fitWorkout.ts — séance Sillance → fichier .FIT « workout » (Garmin)
//  ---------------------------------------------------------------------------
//  Utilisé par export-fit-workout. Le kit FIT (Encoder, Profile) est injecté :
//  esm.sh côté Deno, npm côté tests Node (aller-retour encode → decode).
//
//  Corrigé le 30/10/2026 (le générateur existait mais n'était branché nulle part) :
//   - distances : le constructeur stocke des MÈTRES (pas des km) → 1 000 m
//     devenaient 1 000 km ;
//   - cibles en zone (% FTP, % VMA, % FC max, seuil, PMA, PC, VC) converties
//     avec les références DE L'ATHLÈTE (avant : aucune cible) ;
//   - FC exacte en bpm (lo/hi) ;
//   - muscu : durée en répétitions + nom de l'exercice ;
//   - chaque étape porte un nom lisible sur la montre.
//
//  Conventions FIT (Garmin FIT SDK, workout_step) :
//   durationType time → ms (scale 1000) ; distance → cm (scale 100) ;
//   reps → nombre ; targetType speed → mm/s (scale 1000) ;
//   heartRate → bpm + 100 (0-100 = % FC max) ; power → W + 1000 (0-1000 = % FTP).
// =============================================================================

export type FitLine = {
  type?: string; mode?: string; metric?: string; model?: string; pct?: number; pctTol?: number;
  dur?: { h?: number; m?: number; s?: number };
  dist?: number;            // MÈTRES (constructeur)
  reps?: number; weight?: number; exercise?: string;
  exact?: { kind: string; tol?: number; w?: number; kmh?: number; rpm?: number; m?: number; s?: number; lo?: number; hi?: number };
};
export type FitBlock = { series?: number; title?: string; lines?: FitLine[] };
export type FitSession = { title?: string; disc?: string; blocks?: FitBlock[] };
export type FitRefs = { ftp?: number | null; pma?: number | null; cpBike?: number | null; vma?: number | null; cv?: number | null; seuilRun?: number | null; fcMax?: number | null };

const SPORT_BY_DISC: Record<string, string> = { run: "running", bike: "cycling", swim: "swimming", strength: "training", hyrox: "training" };
const INTENSITY_BY_TYPE: Record<string, string> = { warmup: "warmup", cooldown: "cooldown", recov: "recovery", exo: "active", contre: "active", educatif: "active" };
const NAME_BY_TYPE: Record<string, string> = { warmup: "Echauffement", cooldown: "Retour au calme", recov: "Recup", exo: "Effort", contre: "Contre-effort", educatif: "Educatifs" };

function ascii(s: string, n: number): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "").slice(0, n);
}
function secondsOf(ln: FitLine): number {
  const d = ln.dur || {};
  return (Number(d.h) || 0) * 3600 + (Number(d.m) || 0) * 60 + (Number(d.s) || 0);
}

type Target = { type: string; low?: number; high?: number };
const speedT = (lowMs: number, highMs: number): Target => ({ type: "speed", low: Math.round(Math.max(0.1, Math.min(lowMs, highMs)) * 1000), high: Math.round(Math.max(lowMs, highMs) * 1000) });
const hrT = (lo: number, hi: number): Target => ({ type: "heartRate", low: Math.round(Math.min(lo, hi)) + 100, high: Math.round(Math.max(lo, hi)) + 100 });
const powT = (lo: number, hi: number): Target => ({ type: "power", low: Math.round(Math.max(0, Math.min(lo, hi))) + 1000, high: Math.round(Math.max(lo, hi)) + 1000 });

/** Cible FIT d'une ligne (open si rien de fiable). */
function targetOf(ln: FitLine, disc: string, refs: FitRefs): Target {
  const ex = ln.mode === "exact" ? ln.exact : null;
  if (ex) {
    const tol = Number(ex.tol) || 0;
    if (ex.kind === "hr" && ex.lo) return hrT(Number(ex.lo), Number(ex.hi) || Number(ex.lo));
    if (ex.kind === "power" && ex.w != null) return powT(Number(ex.w) - tol, Number(ex.w) + tol);
    if (ex.kind === "speed" && ex.kmh) return speedT((Number(ex.kmh) - tol) / 3.6, (Number(ex.kmh) + tol) / 3.6);
    if (ex.kind === "pace" && (ex.m || ex.s)) {
      const c = (Number(ex.m) || 0) * 60 + (Number(ex.s) || 0);
      return speedT(1000 / (c + tol), 1000 / Math.max(1, c - tol));
    }
    if (ex.kind === "time100" && (ex.m || ex.s)) {
      const c = (Number(ex.m) || 0) * 60 + (Number(ex.s) || 0);
      return speedT(100 / (c + tol), 100 / Math.max(1, c - tol));
    }
    if (ex.kind === "cadence" && ex.rpm != null) return { type: "cadence", low: Math.max(0, Number(ex.rpm) - tol), high: Number(ex.rpm) + tol };
    return { type: "open" };
  }
  if (ln.mode === "zone" && ln.model) {
    const pct = Number(ln.pct) || 100, tol = Math.max(0, Number(ln.pctTol) || 0);
    const lo = (pct - tol) / 100, hi = (pct + tol) / 100;
    const base = (v: number | null | undefined) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const W = ln.model === "ftp" ? base(refs.ftp) : ln.model === "pma" ? base(refs.pma) : ln.model === "cpBike" ? base(refs.cpBike) : null;
    if (W) return powT(W * lo, W * hi);
    if (ln.model === "fc" && base(refs.fcMax)) return hrT(base(refs.fcMax)! * lo, base(refs.fcMax)! * hi);
    const K = ln.model === "vma" ? base(refs.vma) : ln.model === "cv" ? base(refs.cv) : null;   // km/h
    if (K && disc === "run") return speedT(K * lo / 3.6, K * hi / 3.6);
    // seuil en allure (s/km) : % appliqué à la durée au km, comme le constructeur
    if (ln.model === "seuilRun" && base(refs.seuilRun) && disc === "run") return speedT(1000 / (base(refs.seuilRun)! * hi), 1000 / (base(refs.seuilRun)! * lo));
  }
  return { type: "open" };
}

function pushBlockSteps(steps: Record<string, unknown>[], block: FitBlock, disc: string, refs: FitRefs) {
  const lines = (block.lines || []).filter((l) => l.type !== "station");
  if (!lines.length) return;
  const firstIndex = steps.length;
  for (const ln of lines) {
    const step: Record<string, unknown> = { messageIndex: steps.length, intensity: INTENSITY_BY_TYPE[ln.type || ""] || "active" };
    const name = ln.exercise ? ln.exercise : (NAME_BY_TYPE[ln.type || ""] || "Effort");
    step.wktStepName = ascii(name, 15);
    if (ln.metric === "reps") {
      step.durationType = "reps";
      step.durationValue = Math.max(1, Math.round(Number(ln.reps) || 1));
      if (Number(ln.weight) > 0) { step.exerciseWeight = Number(ln.weight); step.weightDisplayUnit = "kilogram"; }
    } else if (ln.metric === "dist" && Number(ln.dist) > 0) {
      step.durationType = "distance";
      step.durationValue = Math.round(Number(ln.dist) * 100);           // mètres → cm
    } else {
      const sec = secondsOf(ln);
      if (sec > 0) { step.durationType = "time"; step.durationValue = sec * 1000; }
      else step.durationType = "open";                                  // fin au bouton lap
    }
    const t = ln.metric === "reps" ? { type: "open" } : targetOf(ln, disc, refs);
    step.targetType = t.type;
    if (t.type !== "open") { step.targetValue = 0; step.customTargetValueLow = t.low; step.customTargetValueHigh = t.high; }
    steps.push(step);
  }
  const series = Math.max(1, Math.min(99, Number(block.series) || 1));
  if (series > 1) {
    steps.push({ messageIndex: steps.length, durationType: "repeatUntilStepsCmplt", durationValue: firstIndex, targetType: "open", targetValue: series });
  }
}

// deno-lint-ignore no-explicit-any
export function buildFitWorkout(session: FitSession, refs: FitRefs, sdk: { Encoder: any; Profile: any }): Uint8Array {
  const { Encoder, Profile } = sdk;
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: "workout", manufacturer: "development", product: 0,
    timeCreated: new Date(), serialNumber: Math.floor(Math.random() * 0xffffffff),
  });
  const disc = session.disc || "run";
  const steps: Record<string, unknown>[] = [];
  for (const block of session.blocks || []) pushBlockSteps(steps, block, disc, refs || {});
  if (!steps.length) steps.push({ messageIndex: 0, durationType: "open", targetType: "open", intensity: "active" });
  encoder.onMesg(Profile.MesgNum.WORKOUT, {
    sport: SPORT_BY_DISC[disc] || "running",
    numValidSteps: steps.length,
    wktName: ascii(session.title || "Seance Sillance", 30),
  });
  for (const step of steps) encoder.onMesg(Profile.MesgNum.WORKOUT_STEP, step);
  return encoder.close();
}
