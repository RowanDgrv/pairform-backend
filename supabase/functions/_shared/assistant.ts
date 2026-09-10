// =============================================================================
//  _shared/assistant.ts — briques communes de l'API "assistant".
//  ---------------------------------------------------------------------------
//  Résolution du jeton Bearer → { athleteId, canWrite }, journalisation des
//  écritures (image avant/après) et validateurs stricts.
//
//  Toute la sécurité tient à une règle : l'appelant NE fournit JAMAIS d'athlete_id.
//  Il vient du jeton, et chaque requête SQL est bornée dessus.
// =============================================================================
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const DISCIPLINES = ["swim", "bike", "run", "strength", "hyrox", "tri"] as const;
export const ZONES = ["Z1", "Z2", "Z3", "Z4", "Z5"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

export interface AssistantAuth {
  athleteId: string;
  canWrite: boolean;
  tokenHash: string;
}

// -----------------------------------------------------------------------------
//  Auth : hache le Bearer, le cherche en base, vérifie qu'il n'est pas révoqué.
// -----------------------------------------------------------------------------
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function resolveToken(sb: SupabaseClient, authHeader: string): Promise<AssistantAuth | null> {
  const m = /^Bearer\s+(.+)$/i.exec((authHeader ?? "").trim());
  if (!m) return null;
  const tokenHash = await sha256Hex(m[1].trim());

  const { data, error } = await sb.from("assistant_tokens")
    .select("athlete_id, can_write, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;

  // trace d'usage (best-effort, non bloquant)
  sb.from("assistant_tokens").update({ last_used_at: new Date().toISOString() })
    .eq("token_hash", tokenHash).then(() => {}, () => {});

  return { athleteId: data.athlete_id, canWrite: data.can_write, tokenHash };
}

// -----------------------------------------------------------------------------
//  Garde-fou débit : plafonne les écritures (lecture non limitée).
// -----------------------------------------------------------------------------
export async function writeQuotaExceeded(sb: SupabaseClient, athleteId: string): Promise<boolean> {
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { count } = await sb.from("assistant_writes")
    .select("id", { count: "exact", head: true })
    .eq("athlete_id", athleteId).gte("at", since);
  return (count ?? 0) >= 120;   // 120 écritures / 5 min — large pour un usage humain, borne les boucles
}

// -----------------------------------------------------------------------------
//  Journalisation d'une écriture.
// -----------------------------------------------------------------------------
export async function logWrite(sb: SupabaseClient, entry: {
  athleteId: string; op: string; targetId?: string | null;
  params?: unknown; before?: unknown; after?: unknown; ok?: boolean; error?: string | null;
}): Promise<void> {
  await sb.from("assistant_writes").insert({
    athlete_id: entry.athleteId,
    op: entry.op,
    target_id: entry.targetId ?? null,
    params: entry.params ?? {},
    before: entry.before ?? null,
    after: entry.after ?? null,
    ok: entry.ok ?? true,
    error: entry.error ?? null,
  }).then(() => {}, (e) => console.error("assistant logWrite:", String(e).slice(0, 200)));
}

// -----------------------------------------------------------------------------
//  Validateurs — lèvent { status, message } sur entrée invalide.
// -----------------------------------------------------------------------------
export class BadRequest extends Error {
  status = 400;
  constructor(msg: string) { super(msg); }
}

export function reqStr(v: unknown, field: string, max = 300): string {
  if (typeof v !== "string" || !v.trim()) throw new BadRequest(`${field} : chaîne requise`);
  if (v.length > max) throw new BadRequest(`${field} : ${max} caractères max`);
  return v.trim();
}

export function optInt(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new BadRequest(`${field} : entier attendu`);
  if (n < min || n > max) throw new BadRequest(`${field} : entre ${min} et ${max}`);
  return n;
}

export function optNum(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequest(`${field} : nombre attendu`);
  if (n < min || n > max) throw new BadRequest(`${field} : entre ${min} et ${max}`);
  return n;
}

export function optBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return !!v;
}

export function reqDate(v: unknown, field: string): string {
  const s = reqStr(v, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new BadRequest(`${field} : date AAAA-MM-JJ attendue`);
  }
  // borne raisonnable : ±18 mois autour d'aujourd'hui
  const diff = Math.abs(Date.parse(s) - Date.now()) / 86_400_000;
  if (diff > 550) throw new BadRequest(`${field} : hors plage (±18 mois)`);
  return s;
}

export function reqEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  const s = reqStr(v, field, 20);
  if (!allowed.includes(s as T)) throw new BadRequest(`${field} : une valeur parmi ${allowed.join(", ")}`);
  return s as T;
}

export function optEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return reqEnum(v, field, allowed);
}

// -----------------------------------------------------------------------------
//  Charge d'entraînement — port serveur du modèle du front (buildLoadWeeks).
//  EWMA quotidienne : CTL τ=42 j, ATL τ=7 j. ACWR = charge 7 j / charge 28 j.
//  Entrée : liste de { date:'YYYY-MM-DD', tss:number } (séances planifiées OU
//  activités réalisées — l'appelant choisit). Sortie : agrégat du jour courant.
// -----------------------------------------------------------------------------
export function computeLoad(points: { date: string; tss: number }[]): {
  ctl: number; atl: number; tsb: number; acwr: number; acute7: number; chronic28: number;
} {
  if (!points.length) return { ctl: 0, atl: 0, tsb: 0, acwr: 1, acute7: 0, chronic28: 0 };
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(p.date, (byDay.get(p.date) ?? 0) + (Number(p.tss) || 0));

  const days = [...byDay.keys()].sort();
  const start = new Date(days[0] + "T00:00:00Z");
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);

  let ctl = 0, atl = 0;
  const kC = 1 - Math.exp(-1 / 42), kA = 1 - Math.exp(-1 / 7);
  const recent: number[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const load = byDay.get(key) ?? 0;
    ctl += (load - ctl) * kC;
    atl += (load - atl) * kA;
    recent.push(load);
  }
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const acute7 = sum(recent.slice(-7));
  const chronic28 = sum(recent.slice(-28)) / 4;   // ramené à une base 7 j
  return {
    ctl: Math.round(ctl), atl: Math.round(atl), tsb: Math.round(ctl - atl),
    acwr: chronic28 ? +(acute7 / chronic28).toFixed(2) : 1,
    acute7: Math.round(acute7), chronic28: Math.round(chronic28),
  };
}
