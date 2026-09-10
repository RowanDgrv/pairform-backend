import { readFileSync, writeFileSync } from "node:fs";

const lines = readFileSync("extract.txt", "utf8").split("\n").map((l) => l.trim());
const deap = (s) => (s || "").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// label -> field key (superset course + vélo)
const KEY = {
  "Catégorie": "category",
  "Objectif physiologique": "objective",
  "Structure de la séance": "structure",
  "Durée / Distance": "duration_label",
  "Durée": "duration_label",
  "Zone cible": "zone_label",
  "Zone cible (puissance)": "zone_label",
  "Zone cible (fréquence cardiaque)": "zone_hr",
  "Cadence (rpm)": "cadence",
  "RPE (ressenti /10)": "rpe",
  "Récupération": "recovery",
  "Niveau": "level",
  "Justification scientifique": "rationale",
  "Référence": "reference",
};
const LABELS = new Set(Object.keys(KEY));
const isCode = (l) => /^[A-Z0-9]{2,5}-\d{2} — .+/.test(l);
const isSection = (l) => /\(\d+\s*séances\)\s*$/.test(l);

let sport = null;
const fiches = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^Bibliothèque Course à pied/i.test(l)) { sport = "run"; continue; }
  if (/^Bibliothèque Vélo/i.test(l)) { sport = "bike"; continue; }
  if (!sport || !isCode(l)) continue;

  const [code, ...rest] = l.split(" — ");
  const f = { code: code.trim(), sport, title: deap(rest.join(" — ").trim()) };
  let j = i + 1;
  while (j < lines.length) {
    const lab = lines[j];
    if (isCode(lab) || isSection(lab)) break;
    if (LABELS.has(lab)) { f[KEY[lab]] = deap(lines[j + 1] || ""); j += 2; }
    else j += 1;
  }
  fiches.push(f);
}

// ---- enrichments -----------------------------------------------------------
function parseDurMinutes(label) {
  if (!label) return [null, null];
  const s = label.toLowerCase().replace(/total|cumulé/g, "").trim();
  const hm = s.match(/(\d+)\s*h(?:\s*(\d+))?/);
  if (hm) { const v = +hm[1] * 60 + (hm[2] ? +hm[2] : 0); return [v, v]; }
  const range = s.match(/(\d+)\s*[-–]\s*(\d+)\s*min/);
  if (range) return [+range[1], +range[2]];
  const one = s.match(/(\d+)\s*min/);
  if (one) return [+one[1], +one[1]];
  return [null, null];
}
function parseRpe(label) {
  if (!label) return [null, null];
  const r = label.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (r) return [+r[1], +r[2]];
  const one = label.match(/(\d+)/);
  if (one) return [+one[1], +one[1]];
  return [null, null];
}
function zoneFrom(label, isFtp, rpeHigh) {
  const pcts = label ? [...label.matchAll(/(\d+)\s*%/g)].map((m) => +m[1]) : [];
  if (pcts.length) {
    const hi = Math.max(...pcts);
    if (isFtp) {
      if (hi <= 60) return "Z1";
      if (hi <= 83) return "Z2";
      if (hi <= 97) return "Z3";
      if (hi <= 110) return "Z4";
      return "Z5";
    }
    if (hi <= 68) return "Z1";
    if (hi <= 82) return "Z2";
    if (hi <= 90) return "Z3";
    if (hi <= 100) return "Z4";
    return "Z5";
  }
  if (rpeHigh != null) {
    if (rpeHigh <= 4) return "Z2";
    if (rpeHigh <= 6) return "Z3";
    if (rpeHigh <= 8) return "Z4";
    return "Z5";
  }
  return "Z2";
}
const IF_BY_ZONE = { Z1: 0.55, Z2: 0.70, Z3: 0.85, Z4: 0.97, Z5: 1.06 };
const estTss = (durMin, zone) => (durMin ? Math.round((durMin * (IF_BY_ZONE[zone] ?? 0.7) ** 2 * 100) / 60) : 0);
function normLevel(l) {
  const s = (l || "").toLowerCase();
  if (!s || s.includes("tous")) return "tous";
  if (s.includes("interm") && s.includes("avanc")) return "intermediaire_avance";
  if (s.includes("interm")) return "intermediaire";
  if (s.includes("avanc")) return "avance";
  return "tous";
}

let sort = 0;
const rows = fiches.map((f) => {
  const [dmin, dmax] = parseDurMinutes(f.duration_label);
  const [rlo, rhi] = parseRpe(f.rpe);
  const isFtp = f.sport === "bike" || /ftp/i.test(f.zone_label || "");
  const zone = zoneFrom(f.zone_label, isFtp, rhi);
  const dur = dmin && dmax ? Math.round((dmin + dmax) / 2) : (dmin || dmax || 0);
  return {
    code: `${f.sport.toUpperCase()}-${f.code}`,
    sport: f.sport,
    disc: f.sport, // 'run' | 'bike' → enum discipline
    category: f.category || "",
    title: f.title,
    objective: f.objective || "",
    structure: f.structure || "",
    duration_label: f.duration_label || "",
    dur_min: dmin, dur_max: dmax, dur,
    zone_label: f.zone_label || "",
    zone_hr: f.zone_hr || "",
    cadence: f.cadence || "",
    zone,
    rpe_low: rlo, rpe_high: rhi,
    recovery: f.recovery && f.recovery !== "—" ? f.recovery : "",
    level: normLevel(f.level),
    rationale: f.rationale || "",
    reference: f.reference || "",
    tss: estTss(dur, zone),
    sort: ++sort,
  };
});

writeFileSync("library.json", JSON.stringify(rows, null, 2));
const byS = rows.reduce((a, r) => ((a[r.sport] = (a[r.sport] || 0) + 1), a), {});
const cats = [...new Set(rows.map((r) => `${r.sport} / ${r.category}`))];
console.log("fiches:", rows.length, byS);
const bad = rows.filter((r) => !r.title || !r.category || !r.objective || !r.structure || !r.dur || !r.reference);
console.log("incomplètes:", bad.map((b) => `${b.code}(${[!b.category&&"cat",!b.dur&&"dur",!b.reference&&"ref",!b.objective&&"obj"].filter(Boolean)})`));
console.log("catégories:\n  " + cats.join("\n  "));
console.log("\néchantillon:");
for (const r of [rows[0], rows[26], rows[49], rows[50], rows[62], rows[99]]) {
  console.log(`${r.code} · ${r.title} · ${r.category} · ${r.duration_label}→${r.dur}min · ${r.zone_label||r.zone_hr||"—"}→${r.zone} · TSS~${r.tss} · ${r.level}`);
}
