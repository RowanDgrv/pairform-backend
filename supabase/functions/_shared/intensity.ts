// =============================================================================
//  Intensité réelle d'une séance à partir de ses blocs (12/11/2026)
//  ---------------------------------------------------------------------------
//  Avant, une ligne « 3' à 3:10/km » n'avait aucun poids dans le calcul de la
//  zone : une séance de fractionné ressortait en Z2 (échauffement et récup
//  seulement), et le conseiller de chaussure proposait une paire de footing.
//  Ici, chaque ligne d'effort est ramenée à un pourcentage comparable :
//   - course : % de VMA (allure exacte, % VMA, % allure seuil) ;
//   - vélo : % de FTP (watts exacts, % FTP, % PMA) ;
//   - sinon : % de FC max.
//  Repères : ≥ 90 % VMA = fractionné (Z5), 80-90 % = seuil / tempo (Z4).
// =============================================================================
export type Refs = { vma?: number | null; seuil_run?: number | null; ftp?: number | null; pma?: number | null; fc_max?: number | null; fc_repos?: number | null };
// deno-lint-ignore no-explicit-any
type Line = Record<string, any>;

// allure seuil ≈ 87 % de VMA (repère courant quand la VMA n'est pas renseignée)
const SEUIL_PCT_VMA = 87;

export function linePct(l: Line, disc: string, r: Refs): number | null {
  const vma = Number(r.vma) || 0, seuil = Number(r.seuil_run) || 0, ftp = Number(r.ftp) || 0, pma = Number(r.pma) || 0, fcmax = Number(r.fc_max) || 0;
  const e = l.exact;
  if (l.mode === "exact" && e) {
    if (e.kind === "pace") {
      const sec = (Number(e.m) || 0) * 60 + (Number(e.s) || 0); if (!sec) return null;
      const kmh = 3600 / sec;
      if (vma) return (kmh / vma) * 100;
      if (seuil) return (seuil / sec) * SEUIL_PCT_VMA;
      return null;
    }
    if (e.kind === "power") return ftp ? (Number(e.w) / ftp) * 100 : null;
    if (e.kind === "hr") return fcmax ? pctOfHr((Number(e.lo) + Number(e.hi || e.lo)) / 2, fcmax, r.fc_repos) : null;
  }
  if (l.mode === "zone" && Number(l.pct) > 0) {
    const p = Number(l.pct);
    if (l.model === "vma") return p;
    if (l.model === "seuilRun") return (p / 100) * SEUIL_PCT_VMA;
    if (l.model === "ftp") return p;
    if (l.model === "pma") return ftp && pma ? (p * pma) / ftp : p * 1.2;
    if (l.model === "cv") return p * 0.93;
    return p;   // fc
  }
  return null;
}

/** Intensité de la partie la plus dure de la séance (lignes d'effort seulement). */
export function effortPct(blocks: unknown, disc: string, r: Refs): number | null {
  let max: number | null = null;
  for (const b of (Array.isArray(blocks) ? blocks : []) as { lines?: Line[] }[]) {
    for (const l of b.lines || []) {
      if (!["exo", "contre"].includes(String(l.type))) continue;
      const p = linePct(l, disc, r);
      if (p != null && (max == null || p > max)) max = p;
    }
  }
  return max;
}

export const zoneFromPct = (p: number) => p >= 90 ? "Z5" : p >= 80 ? "Z4" : p >= 70 ? "Z3" : p >= 60 ? "Z2" : "Z1";

/** Type de séance pour le choix de la paire : interval (≥ 90 % VMA), tempo (≥ 80 %), easy, ou null si inconnu. */
export function runKind(blocks: unknown, r: Refs): "interval" | "tempo" | "easy" | null {
  const p = effortPct(blocks, "run", r);
  if (p == null) return null;
  return p >= 90 ? "interval" : p >= 77 ? "tempo" : "easy";   // 77 % : allure marathon et au-dessus
}

/* Récupération libre (13/11/2026) : une récup de 3 min ou moins (ou 400 m) n'a pas de
   cible chiffrée, sauf allure / watts / FC tapés à la main par le coach (mode exact).
   Sur 1' de trot entre deux efforts, la FC n'a pas le temps de redescendre : une cible
   « Z1 » ferait biper la montre et compterait la séance comme non respectée. */
// deno-lint-ignore no-explicit-any
export function isFreeRecovery(l: any): boolean {
  if (!l || !["recov", "rec", "recup", "recovery", "repos"].includes(l.type)) return false;
  if (l.mode === "exact") return false;
  if (l.metric === "dist") return (Number(l.dist) || 0) <= 400;
  const sec = (Number(l.dur?.h) || 0) * 3600 + (Number(l.dur?.m) || 0) * 60 + (Number(l.dur?.s) || 0);
  return sec > 0 && sec <= 180;
}

/* Zones de FC en % de la FC de réserve (Karvonen) quand la FC de repos est connue (13/11/2026) :
   bpm = repos + % × (max − repos). En % de FC max brut, la Z2 d'un coureur entraîné
   (ex. 117-137 bpm pour 195 de max) tombait sous ses footings réels (~140). Sans FC de
   repos, on garde le % de FC max. */
export function restOk(max: number, rest?: number | null): number | null {
  const r = Number(rest) || 0; return r >= 30 && r < max - 40 ? r : null;
}
export function hrAt(pct: number, max: number, rest?: number | null): number {
  const r = restOk(max, rest); return r ? r + (pct / 100) * (max - r) : (pct / 100) * max;
}
export function pctOfHr(bpm: number, max: number, rest?: number | null): number {
  const r = restOk(max, rest); return r ? ((bpm - r) / (max - r)) * 100 : (bpm / max) * 100;
}

/* =============================================================================
   Charge d'une séance (TSS), 13/11/2026. Même calcul dans l'app
   (sillance-app.core.js : lineIF / sessionLoad) et dans le script de recalcul.
   TSS = durée (h) × IF² × 100, où IF = intensité rapportée au SEUIL de
   l'athlète (et non à la VMA ou à la FC max, l'erreur d'avant : un footing à
   57 % de VMA comptait comme 57 % du seuil, une allure exacte comptait 85 %).
   Seuil course = allure seuil si renseignée, sinon 87 % de la VMA.
   ============================================================================= */
const IF_DEFAULT: Record<string, number> = { warmup: 0.65, cooldown: 0.62, recov: 0.6, contre: 0.7, educatif: 0.7, exo: 0.85 };
// deno-lint-ignore no-explicit-any
export function lineIF(l: any, disc: string, r: Refs & { cv?: number | null; css?: number | null; cp_bike?: number | null }): number {
  const vma = Number(r.vma) || 0, seuil = Number(r.seuil_run) || 0, ftp = Number(r.ftp) || 0, pma = Number(r.pma) || 0, fcmax = Number(r.fc_max) || 0;
  const thr = seuil ? 3600 / seuil : vma ? vma * SEUIL_PCT_VMA / 100 : 0;   // km/h au seuil
  const hrIF = (bpm: number) => { if (!fcmax) return null; const p = pctOfHr(bpm, fcmax, r.fc_repos); const res = restOk(fcmax, r.fc_repos) ? p : (p - 30) / 0.7; return res / 88; };
  let v: number | null = null;
  if (l.metric === "reps") v = Math.min(1.4, (Number(l.rpe) || 7) * 0.12);
  else if (l.mode === "exact" && l.exact) {
    const e = l.exact;
    if (e.kind === "pace") { const sec = (Number(e.m) || 0) * 60 + (Number(e.s) || 0); if (sec && thr) v = (3600 / sec) / thr; }
    else if (e.kind === "speed") { if (thr && disc === "run") v = Number(e.kmh) / thr; }
    else if (e.kind === "power") { if (ftp) v = Number(e.w) / ftp; }
    else if (e.kind === "hr") v = hrIF((Number(e.lo) + Number(e.hi || e.lo)) / 2);
    else if (e.kind === "rpe") v = 0.2 + (Number(e.rpe) || 6) * 0.1;
  } else if (l.mode === "zone" && Number(l.pct) > 0) {
    const p = Number(l.pct);
    if (l.model === "vma") v = vma && thr ? (vma * p / 100) / thr : p / SEUIL_PCT_VMA;
    else if (l.model === "seuilRun" || l.model === "css") v = 100 / p;   // % d'un temps de référence : plus haut = plus lent
    else if (l.model === "cv" || l.model === "cpBike" || l.model === "ftp") v = p / 100;
    else if (l.model === "pma") v = ftp && pma ? (p * pma / 100) / ftp : p / 75;
    else if (l.model === "fc") v = fcmax ? hrIF(hrAt(p, fcmax, r.fc_repos)) : p / 90;
  }
  if (v == null || !Number.isFinite(v)) v = IF_DEFAULT[l.type] ?? 0.75;
  return Math.max(0.4, Math.min(1.4, v * (disc === "swim" ? 0.95 : 1)));
}
// deno-lint-ignore no-explicit-any
export function lineMin(l: any, disc: string, r: Refs): number {
  if (l.metric === "reps") return (Number(l.reps) || 0) * 3 / 60;
  if (l.metric === "dist") {
    const d = (Number(l.dist) || 0) / 1000, e = l.mode === "exact" ? l.exact : null;
    if (e?.kind === "pace") { const sec = (Number(e.m) || 0) * 60 + (Number(e.s) || 0); if (sec) return d * sec / 60; }
    return d * (disc === "bike" ? 2 : disc === "swim" ? 20 : 5);
  }
  return (Number(l.dur?.h) || 0) * 60 + (Number(l.dur?.m) || 0) + (Number(l.dur?.s) || 0) / 60;
}
const ifZone = (x: number) => x < 0.75 ? "Z1" : x < 0.85 ? "Z2" : x < 0.95 ? "Z3" : x < 1.05 ? "Z4" : "Z5";
/** Durée, charge et zone d'une séance. Zone = la plus haute qui représente au moins 10 % du temps
 *  (2 minutes de lignes droites ne font plus d'un footing une séance « Z3 »). */
// deno-lint-ignore no-explicit-any
export function sessionLoad(blocks: any, disc: string, r: Refs): { min: number; tss: number; zone: string } {
  let min = 0, tss = 0; const byZone: Record<string, number> = {};
  // deno-lint-ignore no-explicit-any
  for (const b of (Array.isArray(blocks) ? blocks : []) as any[]) {
    const n = Math.max(1, Number(b.series) || 1);
    for (const l of b.lines || []) {
      const m = lineMin(l, disc, r) * n, f = lineIF(l, disc, r);
      min += m; tss += (m / 60) * f * f * 100; byZone[ifZone(f)] = (byZone[ifZone(f)] || 0) + m;
    }
  }
  let zone = "Z1", acc = 0;
  for (const z of ["Z5", "Z4", "Z3", "Z2", "Z1"]) { acc += byZone[z] || 0; if (min && acc / min >= 0.1) { zone = z; break; } }
  return { min: Math.round(min), tss: Math.round(tss), zone };
}
