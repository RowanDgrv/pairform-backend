// =============================================================================
//  _shared/coachTools.ts — outils COACH du connecteur Claude (01/11/2026)
//  ---------------------------------------------------------------------------
//  Réservés aux clés scope 'coach' (0084). Périmètre = les athlètes du coach :
//  coach_athlete actif + membres (avec compte) des clubs dont il est
//  propriétaire ou staff (coach/admin) — mêmes règles que push-session-to-watch.
//  Écritures : scheduled_sessions (format du constructeur), journalisées dans
//  assistant_writes avec l'image avant/après.
// =============================================================================
import { linePct, sessionLoad } from "./intensity.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { logWrite, writeQuotaExceeded } from "./assistant.ts";

type Ath = { id: string; nom: string; source: string };

export async function roster(sb: SupabaseClient, coachId: string): Promise<Ath[]> {
  const out = new Map<string, Ath>();
  const { data: links } = await sb.from("coach_athlete").select("athlete_id").eq("coach_id", coachId).eq("status", "active");
  (links ?? []).forEach((l) => out.set(l.athlete_id, { id: l.athlete_id, nom: "", source: "suivi" }));
  const { data: staff } = await sb.from("club_members").select("club_id").eq("athlete_id", coachId).in("role", ["coach", "admin"]);
  const { data: owned } = await sb.from("clubs").select("id").eq("owner_id", coachId);
  const clubIds = [...new Set([...(staff ?? []).map((r) => r.club_id), ...(owned ?? []).map((r) => r.id)])];
  if (clubIds.length) {
    const { data: members } = await sb.from("club_members").select("athlete_id").in("club_id", clubIds).not("athlete_id", "is", null);
    (members ?? []).forEach((m) => { if (!out.has(m.athlete_id)) out.set(m.athlete_id, { id: m.athlete_id, nom: "", source: "club" }); });
  }
  const ids = [...out.keys()];
  if (ids.length) {
    const { data: profs } = await sb.from("profiles").select("id, first_name, last_name, full_name, email").in("id", ids);
    (profs ?? []).forEach((p) => {
      const a = out.get(p.id); if (!a) return;
      a.nom = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.full_name || (p.email ?? "").split("@")[0] || "Athlète";
    });
  }
  return [...out.values()].sort((a, b) => a.nom.localeCompare(b.nom));
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Trouve UN athlète du roster par id ou par nom (partiel accepté s'il est unique). */
export async function findAthlete(sb: SupabaseClient, coachId: string, q: string): Promise<{ ath?: Ath; error?: string }> {
  const list = await roster(sb, coachId);
  const query = String(q || "").trim();
  if (!query) return { error: "Indique l'athlète (nom ou id)." };
  const byId = list.find((a) => a.id === query);
  if (byId) return { ath: byId };
  const n = norm(query);
  const exact = list.filter((a) => norm(a.nom) === n);
  if (exact.length === 1) return { ath: exact[0] };
  const part = list.filter((a) => norm(a.nom).includes(n) || n.split(" ").every((w) => norm(a.nom).includes(w)));
  if (part.length === 1) return { ath: part[0] };
  if (!part.length) return { error: `Aucun athlète « ${query} » dans ton roster. Athlètes : ${list.map((a) => a.nom).join(", ") || "aucun"}.` };
  return { error: `Plusieurs athlètes correspondent à « ${query} » : ${part.map((a) => a.nom).join(", ")}. Précise le nom complet.` };
}

// ---------- conversion étapes → blocs du constructeur ----------
const TYPE: Record<string, string> = { echauffement: "warmup", effort: "exo", recup: "recov", recuperation: "recov", contre_effort: "contre", retour_calme: "cooldown" };
const ZONE_MID: Record<string, number> = { Z1: 55, Z2: 65, Z3: 75, Z4: 85, Z5: 95 };
const REF: Record<string, string> = { vma: "vma", ftp: "ftp", fc: "fc", fcmax: "fc", pma: "pma", seuil: "seuilRun", cv: "cv", pc: "cpBike" };
const DISC = ["run", "bike", "swim", "strength"];

type Ligne = { type?: string; duree_min?: number; distance_m?: number; reps?: number; exercice?: string; charge_kg?: number;
  zone?: string; pct?: number; reference?: string; bpm_min?: number; bpm_max?: number; allure?: string; watts?: number; rpe?: number };
type Bloc = { repetitions?: number; titre?: string; lignes?: Ligne[] };

function toLine(l: Ligne, disc: string, refs: Record<string, number | null> = {}): { line: Record<string, unknown>; min: number; ifac: number } | string {
  const type = TYPE[norm(l.type || "effort").replace(/ /g, "_")] || "exo";
  const line: Record<string, unknown> = { type, rpe: l.rpe ?? undefined };
  let min = 0;
  if (Number(l.reps) > 0) {
    line.metric = "reps"; line.reps = Math.round(Number(l.reps)); line.weight = Number(l.charge_kg) || 0; line.exercise = String(l.exercice || "").slice(0, 60);
    min = Number(l.reps) * 3 / 60;
  } else if (Number(l.distance_m) > 0) {
    line.metric = "dist"; line.dist = Math.round(Number(l.distance_m));
    min = (Number(l.distance_m) / 1000) * (disc === "bike" ? 2 : disc === "swim" ? 20 : 5);
  } else if (Number(l.duree_min) > 0) {
    const sec = Math.round(Number(l.duree_min) * 60);
    line.metric = "time"; line.dur = { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 };
    min = sec / 60;
  } else return "Chaque ligne a besoin d'une durée (duree_min), d'une distance (distance_m) ou de répétitions (reps).";
  // intensité
  let pct = 0;
  if (Number(l.bpm_min) > 0) { line.mode = "exact"; line.exact = { kind: "hr", lo: Number(l.bpm_min), hi: Number(l.bpm_max) || Number(l.bpm_min) }; pct = 75; }
  else if (Number(l.watts) > 0) { line.mode = "exact"; line.exact = { kind: "power", w: Number(l.watts), tol: 5 }; pct = 80; }
  else if (l.allure && /^\d{1,2}:\d{2}$/.test(l.allure)) { const [m, s] = l.allure.split(":").map(Number); line.mode = "exact"; line.exact = { kind: "pace", m, s, tol: 5 }; pct = 85; }
  else if (Number(l.pct) > 0) {
    const model = REF[norm(l.reference || (disc === "bike" ? "ftp" : disc === "run" ? "vma" : "fc"))];
    if (!model) return `Référence inconnue « ${l.reference} » (vma, ftp, fc, pma, seuil, cv, pc).`;
    line.mode = "zone"; line.model = model; line.pct = Number(l.pct); line.pctTol = 2; pct = Number(l.pct);
  } else if (l.zone && ZONE_MID[l.zone.toUpperCase()]) {
    line.mode = "zone"; line.model = "fc"; line.pct = ZONE_MID[l.zone.toUpperCase()]; line.pctTol = 5; pct = line.pct as number;
  } else if (line.metric !== "reps") { line.mode = "zone"; line.model = "fc"; line.pct = type === "exo" ? 75 : 65; line.pctTol = 5; pct = line.pct as number; }   // sans précision : Z2 (13/11/2026)
  // allure, watts ou FC exacts : intensité réelle par rapport aux références de l'athlète (12/11/2026)
  if (line.mode === "exact") { const real = linePct(line, disc, refs); if (real != null) pct = real; }
  const ifac = Math.min(1.1, Math.max(0.5, (pct || 65) / 100));
  return { line, min, ifac };
}

export async function programSession(sb: SupabaseClient, coachId: string, a: Record<string, unknown>): Promise<string> {
  const found = await findAthlete(sb, coachId, String(a.athlete || ""));
  if (!found.ath) return found.error!;
  const date = String(a.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Date attendue au format AAAA-MM-JJ.";
  const today = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
  if (date < today) return `La date ${date} est passée : programme à partir d'aujourd'hui (${today}).`;
  const disc = String(a.sport || "run");
  if (!DISC.includes(disc)) return `Sport inconnu « ${disc} » (run, bike, swim, strength).`;
  const blocsIn = Array.isArray(a.blocs) ? (a.blocs as Bloc[]) : [];
  if (!blocsIn.length) return "Ajoute au moins un bloc avec ses lignes.";
  if (await writeQuotaExceeded(sb, coachId)) return "Trop d'écritures récentes : réessaie dans quelques minutes.";

  const { data: refs } = await sb.from("athlete_profiles").select("vma, seuil_run, ftp, pma, fc_max, fc_repos").eq("user_id", found.ath.id).maybeSingle();
  const blocks: Record<string, unknown>[] = []; let totMin = 0, tss = 0;
  for (const b of blocsIn) {
    const series = Math.max(1, Math.min(40, Math.round(Number(b.repetitions) || 1)));
    const lines: Record<string, unknown>[] = [];
    for (const l of b.lignes || []) {
      const r = toLine(l, disc, refs ?? {});
      if (typeof r === "string") return r;
      lines.push(r.line); totMin += r.min * series; tss += (r.min * series / 60) * r.ifac * r.ifac * 100;
    }
    if (!lines.length) return "Un bloc n'a aucune ligne.";
    // bid/lid : identifiants attendus par l'éditeur de séance de l'app (sans
    // eux, impossible de modifier une ligne créée ici, constaté 05/11/2026)
    const bi = blocks.length;
    lines.forEach((ln, li) => { ln.lid = `la${bi}_${li}_${Date.now().toString(36)}`; });
    blocks.push({ bid: `ba${bi}_${Date.now().toString(36)}`, series, title: String(b.titre || "").slice(0, 60), lines });
  }
  // durée, charge et zone : calcul unique rapporté au seuil de l'athlète (13/11/2026)
  const load = sessionLoad(blocks, disc, refs ?? {});
  const zone = load.zone; totMin = load.min; tss = load.tss;
  const row = { athlete_id: found.ath.id, created_by: coachId, date, disc, title: String(a.titre || "Séance").slice(0, 100),
    dur: Math.round(totMin), dist: 0, tss: Math.round(tss), zone, blocks, coach_note: a.note_coach ? String(a.note_coach).slice(0, 500) : null,
    // consignes nutrition (0097) : seulement si le coach en donne
    ...((a.nutrition_avant || a.nutrition_pendant || a.nutrition_apres) ? { nutrition: { pre: String(a.nutrition_avant || "").slice(0, 400), during: String(a.nutrition_pendant || "").slice(0, 400), post: String(a.nutrition_apres || "").slice(0, 400) } } : {}) };
  const { data, error } = await sb.from("scheduled_sessions").insert(row).select("id").single();
  await logWrite(sb, { athleteId: coachId, op: "coach.session.create", targetId: data?.id ?? null, params: { athlete: found.ath.id, date }, after: row, ok: !error, error: error?.message ?? null });
  if (error) return `Séance non créée : ${error.message}`;
  return `Séance créée pour ${found.ath.nom} le ${date} : « ${row.title} », ${row.dur} min, ${zone}, ${row.tss} TSS estimés (id ${data.id}). Visible dans Sillance ; envoi possible sur sa montre depuis l'app.`;
}

export async function cancelSession(sb: SupabaseClient, coachId: string, id: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) return "Id de séance invalide.";
  const { data: s } = await sb.from("scheduled_sessions").select("*").eq("id", id).maybeSingle();
  if (!s) return "Séance introuvable.";
  const list = await roster(sb, coachId);
  if (!list.some((a) => a.id === s.athlete_id)) return "Cette séance n'appartient pas à un athlète de ton roster.";
  if (s.done) return "Séance déjà réalisée : elle n'est pas supprimée.";
  const { error } = await sb.from("scheduled_sessions").delete().eq("id", id);
  await logWrite(sb, { athleteId: coachId, op: "coach.session.delete", targetId: id, before: s, ok: !error, error: error?.message ?? null });
  return error ? `Suppression impossible : ${error.message}` : `Séance « ${s.title} » du ${s.date} supprimée (copie gardée dans le journal).`;
}

export async function athletePlanning(sb: SupabaseClient, coachId: string, a: Record<string, unknown>): Promise<string> {
  const found = await findAthlete(sb, coachId, String(a.athlete || ""));
  if (!found.ath) return found.error!;
  const today = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(a.from || "")) ? String(a.from) : today;
  const toD = new Date(from + "T12:00:00Z"); toD.setUTCDate(toD.getUTCDate() + 13);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(a.to || "")) ? String(a.to) : toD.toISOString().slice(0, 10);
  const { data } = await sb.from("scheduled_sessions").select("id, date, disc, title, dur, tss, zone, done, coach_note")
    .eq("athlete_id", found.ath.id).gte("date", from).lte("date", to).order("date");
  return JSON.stringify({ athlete: found.ath.nom, from, to, seances: data ?? [] });
}
