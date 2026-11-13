// =============================================================================
//  Edge Function : morning-digest
//  La notification du matin de Sillance : séances du jour + matériel à prévoir
//  + rappel nutrition, envoyée par email (Resend) et/ou Web Push selon les
//  préférences de chaque athlète (table notification_prefs).
//
//  Déclencheur : pg_cron toutes les 15 min → POST avec header x-cron-secret.
//  Un utilisateur est servi quand SON heure locale (tz du profil) tombe dans
//  la fenêtre de 15 min de son heure choisie, une seule fois par jour
//  (last_sent_on). Pas de séance aujourd'hui → rien n'est envoyé.
//
//  Secrets : CRON_SECRET, VAPID_KEYS_JSON (paire JWK), VAPID_SUBJECT,
//            RESEND_API_KEY (optionnel — sans lui l'email est ignoré).
// =============================================================================
import { morningCopy } from "../_shared/morningCopy.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";
import { runKind, effortPct, isFreeRecovery, hrAt, type Refs } from "../_shared/intensity.ts";
import { sendFcmPush } from "../_shared/fcm.ts";
import { sendApnsPush } from "../_shared/apns.ts";

const DISC_LABEL: Record<string, string> = {
  swim: "Natation", bike: "Vélo", run: "Course", strength: "Renfo", hyrox: "Hyrox", tri: "Triathlon",
};
const DISC_GEAR: Record<string, string[]> = {
  swim: ["maillot de bain", "bonnet", "lunettes"],
  bike: ["vélo", "casque", "tenue vélo", "bidon"],
  run: ["baskets", "tenue running"],
  strength: ["tapis", "tenue confortable"],
  hyrox: ["chaussures", "gants", "tenue", "eau"],
};
const GEAR_TAGS: Record<string, string> = {
  // plaquettes, pull-buoy, palmes… : via scheduled_sessions.gear (0088)
  "vma": "montre GPS", "vo2max": "montre GPS",
  "longue": "ravitaillement (gels/barres)",
};

type Session = { title: string; disc: string; dur: number; zone: string | null; shoe_id?: string | null; gear?: string[] | null; shoe_name?: string | null; blocks?: unknown };
// libellés du catalogue de matériel (miroir de sillance-equipment.js, FR)
const EQUIP_LABEL: Record<string, string> = {
  rain_jacket: "veste de pluie", headlamp: "lampe frontale", run_belt: "ceinture porte-flasques", trail_poles: "bâtons de trail",
  power_meter: "capteur de puissance", home_trainer: "home-trainer", bike_computer: "compteur GPS vélo", bike_lights: "éclairage vélo",
  paddles: "plaquettes", pullbuoy: "pull-buoy", fins: "palmes", snorkel: "tuba frontal", kickboard: "planche",
  ankle_band: "élastique de chevilles", drag_chute: "parachute", wetsuit: "combinaison néoprène",
  gps_watch: "montre GPS", hr_strap: "ceinture cardio",
  mobility_band: "élastique de mobilité", foam_roller: "rouleau de massage", dumbbells: "haltères", kettlebell: "kettlebell",
};

function fmtDur(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}
// shoes : id → nom des paires choisies par le coach (0086) — « baskets :
// Nike Pegasus 40 » au lieu de « baskets ». Une seule « montre GPS » (plus de
// « montre connectée » en doublon), plus de « pointes » (retour Rowan 03/11).
// owned : matériel déclaré par l'athlète (athlete_equipment, 0087) — ajoute
// la ceinture cardio aux séances intenses course/vélo, le capteur au vélo.
// --- météo (05/11/2026) ------------------------------------------------------
// Séance dehors : course, vélo hors home-trainer, triathlon. Natation et renfo
// exclus. Pas d'heure de séance en base : on regarde la journée (7 h - 20 h).
function hasOutdoor(sessions: Session[]): boolean {
  return sessions.some((s) => (s.disc === "run" || s.disc === "tri" ||
    (s.disc === "bike" && !/home.?trainer|\bht\b|zwift|rouleau/i.test(s.title || ""))));
}
// Position : celle que l'athlète a accepté de partager dans « Rappel du matin »
// (migration 0093), déjà arrondie à 0,1° (~10 km) par l'app. Seules ces
// coordonnées approximatives partent vers Open-Meteo, sans aucun identifiant.
// Pas d'accord ou pas de position → pas de règle météo. Requête à part et
// tolérante : si la colonne manque, le rappel part quand même, sans météo.
// (10/11/2026 : remplace le départ de la dernière sortie Strava.)
// deno-lint-ignore no-explicit-any
async function lastPosition(sb: any, uid: string): Promise<[number, number] | null> {
  const { data, error } = await sb.from("notification_prefs").select("weather_lat, weather_lon").eq("user_id", uid).maybeSingle();
  if (error || !data) return null;
  const lat = Number((data as { weather_lat: unknown }).weather_lat), lon = Number((data as { weather_lon: unknown }).weather_lon);
  if ((data as { weather_lat: unknown }).weather_lat == null || (data as { weather_lon: unknown }).weather_lon == null) return null;
  return isFinite(lat) && isFinite(lon) ? [lat, lon] : null;
}
// Pluie probable : probabilité ≥ 60 % sur au moins une heure entre 7 h et 20 h,
// ou cumul ≥ 1 mm. Erreur ou délai dépassé (3 s) → on n'ajoute rien.
// 10/11/2026 : on renvoie aussi la plage horaire de la pluie (première et
// dernière heure pluvieuse entre 7 h et 20 h) pour l'annoncer dans le mail :
// « La météo annonce de la pluie entre 16 h et 19 h ».
/* Météo du jour (13/11/2026) : pluie éventuelle + températures, pour une ligne toujours présente
   quand l'athlète a donné sa position ou sa ville (et plus seulement quand il pleut). */
async function dayWeather(lat: number, lon: number, day: string): Promise<{ rain: { from: number; to: number } | null; tmin: number | null; tmax: number | null } | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_min,temperature_2m_max&timezone=Europe%2FParis&start_date=${day}&end_date=${day}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const j = res.ok ? await res.json() : null;
    const tmin = j?.daily?.temperature_2m_min?.[0], tmax = j?.daily?.temperature_2m_max?.[0];
    return { rain: await rainWindow(lat, lon, day), tmin: tmin == null ? null : Math.round(tmin), tmax: tmax == null ? null : Math.round(tmax) };
  } catch { return null; }
}

/* Déroulé de la séance (13/11/2026) : chaque bloc en clair avec ses allures, watts ou FC calculés
   pour l'athlète, et les consignes du coach par ligne. */
const STEP_LABEL: Record<string, string> = { warmup: "Échauffement", exo: "Effort", contre: "Contre-effort", recov: "Récup", cooldown: "Retour au calme", educatif: "Éducatifs" };
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
// deno-lint-ignore no-explicit-any
function lineTarget(l: any, disc: string, r: Refs): string {
  if (isFreeRecovery(l)) return "trot libre";
  const e = l.mode === "exact" ? l.exact : null;
  if (e) {
    const tol = Number(e.tol) || 0;
    if (e.kind === "pace") { const c = (Number(e.m) || 0) * 60 + (Number(e.s) || 0); return tol ? `entre ${mmss(c - tol)} et ${mmss(c + tol)}/km` : `à ${mmss(c)}/km`; }
    if (e.kind === "power") return tol ? `entre ${Number(e.w) - tol} et ${Number(e.w) + tol} W` : `à ${e.w} W`;
    if (e.kind === "hr") return `entre ${e.lo} et ${e.hi || e.lo} bpm`;
    if (e.kind === "speed") return `à ${e.kmh} km/h`;
    if (e.kind === "rpe") return `à un effort de ${e.rpe}/10`;
    return "";
  }
  if (l.mode === "zone" && Number(l.pct) > 0) {
    const pct = Number(l.pct), tol = Number(l.pctTol) || 0, lo = pct - tol, hi = pct + tol;
    const vma = Number(r.vma) || 0, ftp = Number(r.ftp) || 0, fcmax = Number(r.fc_max) || 0;
    if (l.model === "vma" && vma && disc === "run") return `entre ${mmss(3600 / (vma * hi / 100))} et ${mmss(3600 / (vma * lo / 100))}/km`;
    if (l.model === "ftp" && ftp) return `entre ${Math.round(ftp * lo / 100)} et ${Math.round(ftp * hi / 100)} W`;
    if (l.model === "fc" && fcmax) return `entre ${Math.round(hrAt(lo, fcmax, r.fc_repos))} et ${Math.round(hrAt(hi, fcmax, r.fc_repos))} bpm`;
  }
  return "";
}
// deno-lint-ignore no-explicit-any
function lineDur(l: any): string {
  if (l.metric === "dist") { const d = Number(l.dist) || 0; return d >= 1000 ? `${+(d / 1000).toFixed(2)} km` : `${d} m`; }
  if (l.metric === "reps") return `${l.reps || 0} répétitions`;
  const t = (Number(l.dur?.h) || 0) * 3600 + (Number(l.dur?.m) || 0) * 60 + (Number(l.dur?.s) || 0);
  if (!t) return "";
  const m = Math.floor(t / 60), sec = t % 60;
  return t >= 3600 ? `${Math.floor(t / 3600)} h ${String(m % 60).padStart(2, "0")}` : sec ? `${m}'${String(sec).padStart(2, "0")}` : `${m}'`;
}
// deno-lint-ignore no-explicit-any
function stepsFor(s: any, r: Refs): string[] {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  for (const b of (Array.isArray(s.blocks) ? s.blocks : []) as any[]) {
    // deno-lint-ignore no-explicit-any
    let prev = "";
    // deno-lint-ignore no-explicit-any
    const parts = (b.lines || []).map((l: any) => {
      const tgt = lineTarget(l, s.disc, r), note = String(l.note || "").trim();
      const label = l.type === prev ? lineDur(l) : `${STEP_LABEL[l.type] || "Bloc"} ${lineDur(l)}`.trim();   // pas deux fois « Échauffement »
      prev = l.type;
      // une ligne avec une consigne (gammes, éducatifs…) se lit par sa consigne, sans cible chiffrée
      const t = note && l.type !== "exo" ? "" : tgt === "trot libre" ? "en trot libre" : tgt;
      return [label, t, note ? (t ? `(${note})` : `: ${note}`) : ""].filter(Boolean).join(" ");
    }).filter(Boolean);
    if (!parts.length) continue;
    const n = Number(b.series) || 1;
    out.push(n > 1 ? `${n} × [ ${parts.join(", puis ")} ]` : parts.join(", puis "));
  }
  return out;
}

async function rainWindow(lat: number, lon: number, day: string): Promise<{ from: number; to: number } | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=precipitation_probability,precipitation&timezone=Europe%2FParis&start_date=${day}&end_date=${day}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    const t: string[] = j?.hourly?.time ?? [], pp: number[] = j?.hourly?.precipitation_probability ?? [], mm: number[] = j?.hourly?.precipitation ?? [];
    let maxP = 0, sum = 0; const wet: number[] = [];
    t.forEach((h, i) => {
      const hh = +h.slice(11, 13);
      if (hh >= 7 && hh <= 20) {
        maxP = Math.max(maxP, pp[i] ?? 0); sum += mm[i] ?? 0;
        if ((pp[i] ?? 0) >= 60 || (mm[i] ?? 0) >= 0.2) wet.push(hh);
      }
    });
    if (!(maxP >= 60 || sum >= 1) || !wet.length) return null;
    return { from: Math.min(...wet), to: Math.max(...wet) + 1 };
  } catch { return null; }
}

function gearFor(sessions: Session[], shoes: Map<string, string> = new Map(), owned: Set<string> = new Set()): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    const shoe = s.disc === "run" ? ((s.shoe_id ? shoes.get(s.shoe_id) : undefined) ?? s.shoe_name ?? undefined) : undefined;
    (DISC_GEAR[s.disc] ?? []).forEach((g) => set.add(g === "baskets" && shoe ? `baskets : ${shoe}` : g));
    // Montre GPS à chaque séance course, vélo ou triathlon (10/11/2026) : avant,
    // seulement les séances intenses, donc absente d'un simple footing.
    if (["run", "bike", "tri"].includes(s.disc)) set.add("montre GPS");
    const t = (s.title ?? "").toLowerCase();
    for (const k in GEAR_TAGS) if (t.includes(k)) set.add(GEAR_TAGS[k]);
    if (["Z4", "Z5"].includes(s.zone ?? "") || /vma|vo2|seuil|intervalle|fractionn/i.test(t)) {
      set.add("montre GPS");
      if (["run", "bike"].includes(s.disc) && owned.has("hr_strap")) set.add(EQUIP_LABEL.hr_strap);
    }
    if (s.disc === "bike" && owned.has("power_meter")) set.add(EQUIP_LABEL.power_meter);
    for (const k of s.gear ?? []) set.add(EQUIP_LABEL[k] ?? k.replace(/^custom:/, "").replace(/-/g, " "));
  }
  return [...set];
}
// Conseiller de paire (10/11/2026), miroir de recommendShoe() de l'app : quand
// ni le coach ni l'athlète n'ont choisi de paire pour une séance de course, on
// propose celle de l'athlète qui correspond au type de séance (usages cochés
// sur la paire, sinon sa catégorie), la moins usée d'abord. Avant, le mail
// disait juste « baskets » alors que l'app conseillait déjà une paire.
type Shoe = { name: string; km: number; max_km: number; cat: string | null; session_types: string[] | null };
function recommendShoe(s: Session, shoes: Shoe[], refs: Refs = {}): string | null {
  if (s.disc !== "run" || !shoes.length) return null;
  const t = (s.title ?? "").toLowerCase();
  let want: "race" | "interval" | "tempo" | "easy";
  // 12/11/2026 : les allures des blocs comparées à la VMA ou à l'allure seuil priment sur le titre et la zone
  const byPace = runKind(s.blocks, refs);
  if (/comp[ée]t|course|marathon|semi|10k|5k|race/.test(t)) want = "race";
  else if (byPace) want = byPace;
  else if (/vma|fractionn|interval|r[ée]p[ée]tition/.test(t) || s.zone === "Z5") want = "interval";
  else if (/seuil|tempo|vo2|dynamique|allure/.test(t) || s.zone === "Z4") want = "tempo";
  else want = "easy";
  const has = (g: Shoe, k: string) => Array.isArray(g.session_types) && g.session_types.includes(k);
  const preds: Record<string, ((g: Shoe) => boolean)[]> = {
    race: [(g) => has(g, "race"), (g) => has(g, "tempo"), (g) => g.cat === "race", (g) => g.cat === "tempo"],
    interval: [(g) => has(g, "interval"), (g) => has(g, "tempo"), (g) => has(g, "race"), (g) => g.cat === "tempo"],
    tempo: [(g) => has(g, "tempo"), (g) => has(g, "interval"), (g) => g.cat === "tempo", (g) => g.cat === "daily"],
    easy: [(g) => has(g, "easy"), (g) => g.cat === "daily", (g) => has(g, "tempo")],
  };
  for (const pred of preds[want]) {
    const cand = shoes.filter(pred).sort((x, y) => x.km / x.max_km - y.km / y.max_km)[0];
    if (cand) return cand.name;
  }
  return null;   // aucune paire adaptée : on reste sur « baskets », sans en imposer une au hasard
}
function nutriFor(sessions: Session[]): string {
  const long = sessions.some((s) => (s.dur ?? 0) >= 120);
  const hard = sessions.some((s) => ["Z4", "Z5"].includes(s.zone ?? ""));
  if (long) return "prévois 30 à 60 g de glucides par heure (gels, barres, boisson).";
  if (hard) return "une collation glucidique 1 à 2 h avant, des protéines dans les 30 min après.";
  return "hydrate-toi bien tout au long de la journée.";
}

/* heure locale (h, min, date ISO) d'un fuseau donné */
function localNow(tz: string): { h: number; m: number; day: string } {
  try {
    const parts = new Intl.DateTimeFormat("fr-CA", {
      timeZone: tz, hour: "2-digit", minute: "2-digit",
      year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
    return { h: +g("hour") % 24, m: +g("minute"), day: `${g("year")}-${g("month")}-${g("day")}` };
  } catch {
    const d = new Date();
    return { h: d.getUTCHours(), m: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // --- gate cron (fonction déployée sans verify_jwt) ---
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (!secret || req.headers.get("x-cron-secret") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Web Push prêt si les clés VAPID sont posées ---
    let appServer: webpush.ApplicationServer | null = null;
    const vapidJson = Deno.env.get("VAPID_KEYS_JSON");
    if (vapidJson) {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(vapidJson), { extractable: false });
      appServer = await webpush.ApplicationServer.new({
        contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:rowandegraeve@gmail.com",
        vapidKeys,
      });
    }

    const { data: prefs, error: pErr } = await supabase
      .from("notification_prefs")
      .select("user_id, send_hour, send_minute, tz, channel, last_sent_on, eve_enabled")
      .neq("channel", "none");
    if (pErr) throw pErr;

    let sent = 0, skipped = 0, failed = 0;
    for (const p of prefs ?? []) {
      const now = localNow(p.tz || "Europe/Paris");
      const inWindow = now.h === p.send_hour && now.m >= p.send_minute && now.m < p.send_minute + 15;
      // un seul rappel au choix de l'athlète (13/11/2026) : la veille au soir OU le matin même, jamais les deux
      if ((p as { eve_enabled?: boolean }).eve_enabled) { skipped++; continue; }
      if (!inWindow || p.last_sent_on === now.day) { skipped++; continue; }

      // séances planifiées AUJOURD'HUI (heure locale de l'athlète)
      const { data: sessions } = await supabase
        .from("scheduled_sessions")
        .select("title, disc, dur, zone, shoe_id, gear, coach_note, blocks, nutrition, created_by")
        .eq("athlete_id", p.user_id)
        .eq("date", now.day)
        .eq("done", false);
      if (!sessions?.length) { skipped++; continue; }

      const lines = sessions.map((s) =>
        `${DISC_LABEL[s.disc] ?? s.disc} : ${s.title}` +
        ` (${fmtDur(s.dur ?? 0)}${s.zone ? " · " + s.zone : ""})`
      );
      const shoeIds = [...new Set(sessions.map((s) => s.shoe_id).filter(Boolean))] as string[];
      const shoes = new Map<string, string>();
      if (shoeIds.length) {
        const { data: g } = await supabase.from("gear").select("id, name").in("id", shoeIds);
        (g ?? []).forEach((x) => shoes.set(x.id, x.name));
      }
      const { data: eq } = await supabase.from("athlete_equipment").select("item_key").eq("athlete_id", p.user_id);
      const owned = new Set((eq ?? []).map((r) => r.item_key as string));
      if ((sessions as Session[]).some((s) => s.disc === "run" && !s.shoe_id)) {
        const { data: pairs } = await supabase.from("gear").select("name, km, max_km, cat, session_types, retired")
          .eq("athlete_id", p.user_id).eq("type", "shoe");
        const alive: Shoe[] = (pairs ?? []).filter((g) => !g.retired && Number(g.km) < Number(g.max_km))
          .map((g) => ({ name: g.name as string, km: Number(g.km), max_km: Number(g.max_km) || 1, cat: g.cat as string | null, session_types: g.session_types as string[] | null }));
        const { data: refs } = await supabase.from("athlete_profiles").select("vma, seuil_run, ftp, pma, fc_max, fc_repos").eq("user_id", p.user_id).maybeSingle();
        for (const s of sessions as Session[]) if (s.disc === "run" && !s.shoe_id) s.shoe_name = recommendShoe(s, alive, refs ?? {});
      }
      const gear = gearFor(sessions as Session[], shoes, owned);
      // Veste de pluie si pluie probable en journée et séance dehors (05/11/2026)
      let weatherLine = "";
      if (!gear.some((g) => g.startsWith("veste de pluie")) && hasOutdoor(sessions as Session[])) {
        const pos = await lastPosition(supabase, p.user_id);
        const w = pos ? await dayWeather(pos[0], pos[1], now.day) : null;
        const temp = w && w.tmin != null && w.tmax != null ? ` Entre ${w.tmin} et ${w.tmax} °C dans la journée.` : "";
        if (w?.rain) {
          gear.push("veste de pluie (pluie prévue)");
          weatherLine = `La météo annonce de la pluie entre ${w.rain.from} h et ${w.rain.to} h : prévois ta veste de pluie.${temp}`;
        } else if (w) {
          weatherLine = `Pas de pluie prévue aujourd'hui.${temp}`;
        }
      }
      // Nutrition (12/11/2026) : uniquement les consignes écrites (ou validées) par le coach, et seulement
      // si ce coach n'a pas masqué la nutrition à ses athlètes. Plus de texte générique inventé.
      let nutri = "";
      {
        // deno-lint-ignore no-explicit-any
        const ss = sessions as any[];
        const creators = [...new Set(ss.map((x) => x.created_by).filter(Boolean))];
        const { data: cp } = creators.length ? await supabase.from("profiles").select("id, show_nutrition").in("id", creators) : { data: [] };
        const hidden = new Set((cp ?? []).filter((c: { show_nutrition: boolean }) => c.show_nutrition === false).map((c: { id: string }) => c.id));
        const parts: string[] = [];
        for (const x of ss) {
          if (x.created_by && hidden.has(x.created_by)) continue;
          const n = x.nutrition || {};
          const t = [n.pre && "avant : " + n.pre, n.during && "pendant : " + n.during, n.post && "après : " + n.post].filter(Boolean).join(" ; ");
          if (t) parts.push(ss.length > 1 ? `${x.title} (${t})` : t);
        }
        nutri = parts.join(" · ").slice(0, 700);
      }
      // Textes variés du jour (05/11/2026) : prénom de l'athlète, prénom du
      // coach qui signe, accroche selon la séance et le jour de la semaine.
      const { data: me } = await supabase.from("profiles").select("email, first_name, full_name").eq("id", p.user_id).single();
      const { data: link } = await supabase.from("coach_athlete").select("coach_id").eq("athlete_id", p.user_id).eq("status", "active").limit(1).maybeSingle();
      let coachFirst: string | null = null;
      if (link?.coach_id && link.coach_id !== p.user_id) {
        const { data: c } = await supabase.from("profiles").select("first_name, full_name").eq("id", link.coach_id).single();
        coachFirst = c?.first_name || (c?.full_name || "").split(" ")[0] || null;
      }
      const firstName = me?.first_name || (me?.full_name || "").split(" ")[0] || null;
      let steps: string[] = [];
      // intensité réelle de chaque séance (allures / watts / FC demandés vs références de l'athlète)
      {
        const { data: rf } = await supabase.from("athlete_profiles").select("vma, seuil_run, ftp, pma, fc_max, fc_repos").eq("user_id", p.user_id).maybeSingle();
        // deno-lint-ignore no-explicit-any
        for (const s of sessions as any[]) s.effort = effortPct(s.blocks, s.disc, rf ?? {});
        // deno-lint-ignore no-explicit-any
        steps = (sessions as any[]).flatMap((s) => stepsFor(s, rf ?? {}));
      }
      const copy = morningCopy(sessions as Session[], { firstName, coachFirstName: coachFirst, day: now.day, userId: p.user_id });
      const title = copy.subject;
      // commentaire du coach sur la séance (05/11/2026) : « Le mot de Rowan »
      const notes = (sessions as { coach_note?: string | null }[]).map((x) => (x.coach_note || "").trim()).filter(Boolean);
      const bodyTxt = `${copy.intro}\n\n${copy.gearLabel} ${gear.join(", ")}${weatherLine ? `\n${weatherLine}` : ""}${notes.length ? `\n\n${notes.join(" ")}` : ""}`;

      // Un athlète en erreur ne doit jamais bloquer les suivants (avant : une
      // exception sortait de la boucle → 500 → tous les athlètes restants
      // perdaient leur rappel du jour, la fenêtre de 15 min étant passée).
      // `delivered` ne compte que ce qui est VRAIMENT parti : sendEmail renvoie
      // false sans lever d'erreur quand Resend refuse ou n'est pas configuré
      // (constaté 27/10/2026 : RESEND_API_KEY absent, la fonction annonçait
      // sent:1 alors qu'aucun email n'était envoyé).
      try {
        const [emailOk, pushOk] = await Promise.all([
          (async () => {
            if (p.channel !== "email" && p.channel !== "both") return false;
            if (!me?.email) return false;
            return await sendEmail({
              to: me.email,
              subject: title,
              html: digestHtml(copy, lines, gear, nutri, notes, coachFirst, weatherLine, steps, now.day),
            });
          })(),
          (async () => {
            if (p.channel !== "push" && p.channel !== "both") return false;
            const { data: subs } = await supabase.from("push_subscriptions")
              .select("id, endpoint, p256dh, auth, platform").eq("user_id", p.user_id);
            // Lu côté client au tap (silOnNotificationTap) pour amener directement
            // l'athlète sur sa vue plutôt que sur l'écran par défaut de l'app.
            const pushData = { type: "morning_digest" };
            let ok = false;
            for (const s of subs ?? []) {
              if (s.platform === "android") {
                const r = await sendFcmPush(s.endpoint, { title, body: bodyTxt, data: pushData });
                if (r.ok) ok = true;
                else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
                continue;
              }
              if (s.platform === "ios") {
                const r = await sendApnsPush(s.endpoint, { title, body: bodyTxt, data: pushData });
                if (r.ok) ok = true;
                else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
                continue;
              }
              if (!appServer) continue;
              try {
                const subscriber = appServer.subscribe({
                  endpoint: s.endpoint,
                  keys: { p256dh: s.p256dh, auth: s.auth },
                });
                await subscriber.pushTextMessage(JSON.stringify({
                  title, body: bodyTxt, url: `./sillance-app.html?jour=${now.day}`,   // ouvre le récap de la séance du jour (13/11/2026)
                }), {});
                ok = true;
              } catch (e) {
                // abonnement mort (navigateur désinscrit) → on le retire
                const msg = String(e);
                if (msg.includes("404") || msg.includes("410")) {
                  await supabase.from("push_subscriptions").delete().eq("id", s.id);
                } else console.warn("push KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
              }
            }
            return ok;
          })(),
        ]);

        if (emailOk || pushOk) {
          await supabase.from("notification_prefs")
            .update({ last_sent_on: now.day }).eq("user_id", p.user_id);
          sent++;
        } else {
          failed++;
          console.warn("morning-digest: rien n'a pu être envoyé à", p.user_id, "canal", p.channel);
        }
      } catch (e) {
        failed++;
        console.error("morning-digest: erreur pour", p.user_id, e);
      }
    }
    // --- Rappel de la veille (13/11/2026, option de l'athlète) ---------------------------
    // À l'heure choisie la veille : « C'est prévu pour demain : … Prépare ton sac : … »,
    // même canal que le rappel du matin, lien vers le récap de la séance de demain.
    let eveSent = 0;
    const { data: eprefs } = await supabase.from("notification_prefs")
      .select("user_id, tz, channel, eve_enabled, eve_hour, eve_minute, eve_last_sent_on")
      .eq("eve_enabled", true).neq("channel", "none");
    for (const p of eprefs ?? []) {
      try {
        const now = localNow(p.tz || "Europe/Paris");
        const inWin = now.h === p.eve_hour && now.m >= p.eve_minute && now.m < p.eve_minute + 15;
        if (!inWin || p.eve_last_sent_on === now.day) continue;
        const d = new Date(now.day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
        const tomorrow = d.toISOString().slice(0, 10);
        const { data: ss } = await supabase.from("scheduled_sessions").select("title, disc, dur, zone, shoe_id, gear, blocks")
          .eq("athlete_id", p.user_id).eq("date", tomorrow).eq("done", false);
        if (!ss?.length) continue;
        const shoes = new Map<string, string>();
        const ids = [...new Set(ss.map((x) => x.shoe_id).filter(Boolean))] as string[];
        if (ids.length) { const { data: g } = await supabase.from("gear").select("id, name").in("id", ids); (g ?? []).forEach((x) => shoes.set(x.id, x.name)); }
        const { data: eq } = await supabase.from("athlete_equipment").select("item_key").eq("athlete_id", p.user_id);
        const gear = gearFor(ss as Session[], shoes, new Set((eq ?? []).map((r) => r.item_key as string)));
        const what = ss.map((x) => `${x.title} (${fmtDur(x.dur ?? 0)}${x.zone ? " · " + x.zone : ""})`).join(" + ");
        const title = ss.length > 1 ? `Demain : ${ss.length} séances` : `Demain : ${ss[0].title}`;
        const body = `C'est prévu pour demain : ${what}.${gear.length ? ` Prépare ton sac : ${gear.join(", ")}.` : ""}`;
        const url = `./sillance-app.html?jour=${tomorrow}`;
        const { data: me } = await supabase.from("profiles").select("email, first_name, full_name").eq("id", p.user_id).single();
        const first = me?.first_name || (me?.full_name || "").split(" ")[0] || "";
        const [eOk, pOk] = await Promise.all([
          (p.channel === "email" || p.channel === "both") && me?.email
            ? sendEmail({ to: me.email, subject: title, html: eveHtml(first, what, gear, tomorrow) }) : Promise.resolve(false),
          (p.channel === "push" || p.channel === "both") ? pushToUser(supabase, appServer, p.user_id, title, body, url) : Promise.resolve(false),
        ]);
        if (eOk || pOk) { await supabase.from("notification_prefs").update({ eve_last_sent_on: now.day }).eq("user_id", p.user_id); eveSent++; }
      } catch (e) { console.error("rappel de la veille : erreur pour", p.user_id, e); }
    }
    return json({ ok: true, sent, skipped, failed, eveSent });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

/** Envoie une notification sur tous les appareils d'un utilisateur (web, Android, iOS). */
// deno-lint-ignore no-explicit-any
async function pushToUser(supabase: any, appServer: webpush.ApplicationServer | null, uid: string, title: string, body: string, url: string): Promise<boolean> {
  const { data: subs } = await supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth, platform").eq("user_id", uid);
  let ok = false;
  for (const s of subs ?? []) {
    try {
      if (s.platform === "android" || s.platform === "ios") {
        const r = s.platform === "android" ? await sendFcmPush(s.endpoint, { title, body, data: { type: "eve_reminder" } })
          : await sendApnsPush(s.endpoint, { title, body, data: { type: "eve_reminder" } });
        if (r.ok) ok = true; else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
        continue;
      }
      if (!appServer) continue;
      const sub = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await sub.pushTextMessage(JSON.stringify({ title, body, url }), {});
      ok = true;
    } catch (e) {
      const msg = String(e);
      if (msg.includes("404") || msg.includes("410")) await supabase.from("push_subscriptions").delete().eq("id", s.id);
      else console.warn("push KO:", String(s.endpoint).slice(0, 40), msg.slice(0, 120));
    }
  }
  return ok;
}
function eveHtml(first: string, what: string, gear: string[], day: string): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720;font-size:16px;line-height:1.6">
    <p>Bonsoir${first ? " " + escapeHtml(first) : ""},</p>
    <p>C'est prévu pour demain : <b>${escapeHtml(what)}</b>.</p>
    ${gear.length ? `<p style="margin-bottom:4px"><b>Prépare ton sac ce soir</b></p><ul style="line-height:1.7;padding-left:20px;margin-top:4px">${gear.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>` : ""}
    <p style="margin:18px 0"><a href="https://sillance.app/sillance-app.html?jour=${day}" style="display:inline-block;background:#0B7285;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">Voir la séance de demain</a></p>
    <p>Bonne soirée, et dors bien.<br>L'équipe Sillance</p>
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Tu reçois ce mail car le rappel de la veille est activé dans Sillance. Tu peux changer l'heure ou le couper à tout moment dans Paramètres > Rappels.</p>
  </div>`;
}
function digestHtml(copy: ReturnType<typeof morningCopy>, lines: string[], gear: string[], nutri: string, notes: string[] = [], coach: string | null = null, weatherLine = "", steps: string[] = [], day = ""): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f1720;font-size:16px;line-height:1.6">
    <p>${escapeHtml(copy.greeting)}</p>
    <p>${copy.weekdayLine ? escapeHtml(copy.weekdayLine) + " " : ""}${escapeHtml(copy.intro)}</p>
    <ul style="line-height:1.7;padding-left:20px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    ${steps.length ? `<p style="margin-bottom:4px"><b>Le déroulé</b></p><ol style="line-height:1.7;padding-left:22px;margin-top:4px">${steps.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>` : ""}
    ${day ? `<p style="margin:18px 0"><a href="https://sillance.app/sillance-app.html?jour=${day}" style="display:inline-block;background:#0B7285;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">Voir ma séance du jour</a></p>` : ""}
    <p><b>${escapeHtml(copy.gearLabel)}</b> ${gear.map(escapeHtml).join(", ")}</p>
    ${weatherLine ? `<p style="background:#eef4fb;border-radius:10px;padding:12px 14px">${weatherLine.startsWith("Pas de pluie") ? "☀️" : "☔"} ${escapeHtml(weatherLine)}</p>` : ""}
    ${nutri ? `<p style="background:#f0f7f4;border-radius:10px;padding:12px 14px"><b>${escapeHtml(copy.nutriLabel)}</b> ${escapeHtml(nutri)}</p>` : ""}
    ${notes.length
      ? `<p style="border-left:3px solid #0B7285;padding:4px 0 4px 14px"><span style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0B7285;font-weight:700">Le mot de ${escapeHtml(coach || "ton coach")}</span><br>${notes.map(escapeHtml).join("<br>")}</p><p>${escapeHtml(copy.signature)}</p>`
      : `<p>${escapeHtml(copy.closing)}<br>${escapeHtml(copy.signature)}</p>`}
    <p style="font-size:12px;color:#6b7682;margin-top:24px">Tu reçois ce mail car le rappel du matin est activé dans Sillance. Tu peux changer l'heure ou le couper à tout moment : <a href="https://sillance.app/sillance-app.html" style="color:#6b7682">mon rappel du matin</a>.</p>
  </div>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
