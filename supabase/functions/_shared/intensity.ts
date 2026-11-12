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
