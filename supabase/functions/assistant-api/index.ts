// =============================================================================
//  Edge Function : assistant-api          (déployer avec --no-verify-jwt)
//  ---------------------------------------------------------------------------
//  API REST minimale pour piloter le compte d'UN athlète depuis un agent
//  externe — un GPT personnalisé ChatGPT, Claude, ou un script. Pensée pour
//  l'usage perso de Rowan (compte admin) : « demande à ChatGPT d'ajouter une
//  séance / de saisir mon check-in / d'analyser ma charge ».
//
//  Auth  : header  Authorization: Bearer <jeton>   (voir assistant_mint_token).
//          Le jeton porte l'athlete_id + le droit d'écriture. L'appelant ne
//          fournit jamais d'athlete_id → aucun autre compte n'est atteignable.
//  Trace : toute écriture est journalisée (assistant_writes, image avant/après).
//
//  Secrets : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
//  Schéma OpenAPI (à coller dans un GPT personnalisé) : ./openapi.json
// =============================================================================
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  resolveToken, writeQuotaExceeded, logWrite, computeLoad,
  BadRequest, DISCIPLINES, ZONES,
  reqStr, reqDate, reqEnum, optEnum, optInt, optNum, optBool,
} from "../_shared/assistant.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",              // protégé par Bearer, pas de cookie → pas d'autorité ambiante
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const auth = await resolveToken(sb, req.headers.get("Authorization") ?? "");
  if (!auth) return json({ error: "Jeton invalide ou révoqué" }, 401);
  const A = auth.athleteId;

  // chemin après /functions/v1/assistant-api
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/assistant-api/, "").replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean);          // ex. ["session", "<id>"]
  const q = url.searchParams;

  try {
    // -------- écriture : garde-fous communs --------
    const isWrite = req.method !== "GET";
    if (isWrite) {
      if (!auth.canWrite) return json({ error: "Ce jeton est en lecture seule" }, 403);
      if (await writeQuotaExceeded(sb, A)) return json({ error: "Trop d'écritures — réessaie dans quelques minutes" }, 429);
    }
    const body = isWrite ? await req.json().catch(() => ({})) : {};

    // =========================================================================
    //  LECTURE
    // =========================================================================
    if (req.method === "GET") {
      switch (seg[0]) {
        case undefined:
        case "":
        case "summary":       return json(await getSummary(sb, A));
        case "activities":    return json(await getActivities(sb, A, optInt(q.get("days"), "days", 1, 365) ?? 28));
        case "sessions":      return json(await getSessions(sb, A, q.get("from"), q.get("to")));
        case "session":       return json(await getSession(sb, A, seg[1]));
        case "checkins":      return json(await getCheckins(sb, A, optInt(q.get("days"), "days", 1, 120) ?? 14));
        case "wellness":      return json(await getWellness(sb, A));
        case "records":       return json(await getRecords(sb, A));
        case "refs":          return json(await getRefs(sb, A));
        case "gear":          return json(await getGear(sb, A));
        case "history":       return json(await getHistory(sb, A, optInt(q.get("limit"), "limit", 1, 100) ?? 20));
        default:              return json({ error: `Ressource inconnue : ${seg[0]}` }, 404);
      }
    }

    // =========================================================================
    //  ÉCRITURE
    // =========================================================================
    if (seg[0] === "session" && req.method === "POST")   return json(await createSession(sb, A, body), 201);
    if (seg[0] === "session" && req.method === "PATCH")  return json(await patchSession(sb, A, seg[1], body));
    if (seg[0] === "session" && req.method === "DELETE") return json(await deleteSession(sb, A, seg[1], q.get("confirm") ?? body?.confirm));
    if (seg[0] === "checkin" && (req.method === "PUT" || req.method === "POST")) return json(await upsertCheckin(sb, A, seg[1], body));
    if (seg[0] === "record"  && req.method === "POST")   return json(await createRecord(sb, A, body), 201);
    if (seg[0] === "refs"    && req.method === "PATCH")  return json(await patchRefs(sb, A, body));
    if (seg[0] === "gear"    && req.method === "POST")   return json(await createGear(sb, A, body), 201);
    if (seg[0] === "gear"    && req.method === "PATCH")  return json(await patchGear(sb, A, seg[1], body));

    return json({ error: `${req.method} ${path} non géré` }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("assistant-api:", String(e).slice(0, 300));
    return json({ error: "Erreur serveur" }, 500);
  }
});

// =============================================================================
//  LECTURE — implémentations
// =============================================================================
async function getSummary(sb: SupabaseClient, A: string) {
  const [{ data: planned }, { data: acts }, { data: checkin }, { data: conn }, { data: refs }] = await Promise.all([
    sb.from("scheduled_sessions").select("date, disc, title, dur, tss, zone, done, rpe")
      .eq("athlete_id", A).gte("date", shiftDays(-42)).lte("date", shiftDays(14)).order("date"),
    sb.from("external_activities").select("start_time, disc, name, duration_s, distance_m, avg_hr")
      .eq("user_id", A).gte("start_time", shiftDays(-42)).order("start_time", { ascending: false }).limit(30),
    sb.from("checkins").select("*").eq("athlete_id", A).order("date", { ascending: false }).limit(1),
    sb.from("device_connections").select("provider, meta, last_sync_at").eq("user_id", A),
    sb.from("athlete_profiles").select("*").eq("user_id", A).maybeSingle(),
  ]);

  const loadPlanned = computeLoad((planned ?? []).map((s) => ({ date: s.date, tss: s.tss ?? 0 })));
  const today = iso(new Date());
  const todaySession = (planned ?? []).find((s) => s.date === today) ?? null;
  const wellness = (conn ?? []).map((c) => ({ provider: c.provider, last_sync_at: c.last_sync_at, ...(c.meta?.wellness ?? {}) }))
    .filter((w) => w.hrv || w.recovery || w.load);

  return {
    athlete_id: A,
    generated_at: new Date().toISOString(),
    load: loadPlanned,
    today: todaySession,
    week_ahead: (planned ?? []).filter((s) => s.date >= today && s.date <= shiftDays(7)),
    last_checkin: checkin?.[0] ?? null,
    wellness,
    recent_activities: (acts ?? []).slice(0, 8),
    refs: refs ?? null,
  };
}

async function getActivities(sb: SupabaseClient, A: string, days: number) {
  const { data } = await sb.from("external_activities")
    .select("id, provider, start_time, disc, name, duration_s, distance_m, elevation_m, avg_hr, avg_power, avg_speed, calories")
    .eq("user_id", A).gte("start_time", shiftDays(-days)).order("start_time", { ascending: false }).limit(200);
  return { count: data?.length ?? 0, activities: data ?? [] };
}

async function getSessions(sb: SupabaseClient, A: string, from: string | null, to: string | null) {
  const f = from ? reqDate(from, "from") : shiftDays(-14);
  const t = to ? reqDate(to, "to") : shiftDays(14);
  const { data } = await sb.from("scheduled_sessions")
    .select("id, date, disc, title, dur, dist, tss, zone, blocks, done, rpe, coach_note, created_by")
    .eq("athlete_id", A).gte("date", f).lte("date", t).order("date");
  return { from: f, to: t, count: data?.length ?? 0, sessions: data ?? [] };
}

async function getSession(sb: SupabaseClient, A: string, id?: string) {
  if (!id) throw new BadRequest("id de séance requis");
  const { data } = await sb.from("scheduled_sessions").select("*").eq("athlete_id", A).eq("id", id).maybeSingle();
  if (!data) return { error: "Séance introuvable" };
  return data;
}

async function getCheckins(sb: SupabaseClient, A: string, days: number) {
  const { data } = await sb.from("checkins").select("*")
    .eq("athlete_id", A).gte("date", shiftDays(-days)).order("date", { ascending: false });
  return { count: data?.length ?? 0, checkins: data ?? [] };
}

async function getWellness(sb: SupabaseClient, A: string) {
  const { data } = await sb.from("device_connections").select("provider, meta, last_sync_at, scope").eq("user_id", A);
  return {
    connections: (data ?? []).map((c) => ({
      provider: c.provider, last_sync_at: c.last_sync_at,
      wellness: c.meta?.wellness ?? null,
    })),
  };
}

async function getRecords(sb: SupabaseClient, A: string) {
  const { data } = await sb.from("records").select("id, label, value, is_new, recorded_at")
    .eq("athlete_id", A).order("recorded_at", { ascending: false }).limit(200);
  return { count: data?.length ?? 0, records: data ?? [] };
}

async function getRefs(sb: SupabaseClient, A: string) {
  const { data } = await sb.from("athlete_profiles").select("*").eq("user_id", A).maybeSingle();
  return data ?? {};
}

async function getGear(sb: SupabaseClient, A: string) {
  const { data } = await sb.from("gear").select("id, type, name, brand, km, max_km, retired")
    .eq("athlete_id", A).order("retired").order("km", { ascending: false });
  return { count: data?.length ?? 0, gear: data ?? [] };
}

async function getHistory(sb: SupabaseClient, A: string, limit: number) {
  const { data } = await sb.from("assistant_writes")
    .select("id, op, target_id, params, before, after, ok, error, at")
    .eq("athlete_id", A).order("at", { ascending: false }).limit(limit);
  return { count: data?.length ?? 0, writes: data ?? [] };
}

// =============================================================================
//  ÉCRITURE — implémentations (toutes journalisées)
// =============================================================================
function cleanSession(input: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || "date" in input)  out.date  = reqDate(input.date, "date");
  if (!partial || "disc" in input)  out.disc  = reqEnum(input.disc, "disc", DISCIPLINES);
  if (!partial || "title" in input) out.title = reqStr(input.title, "title", 200);
  const dur = optInt(input.dur, "dur", 0, 1440);          if (dur !== undefined) out.dur = dur;
  const dist = optNum(input.dist, "dist", 0, 2000);       if (dist !== undefined) out.dist = dist;
  const tss = optInt(input.tss, "tss", 0, 2000);          if (tss !== undefined) out.tss = tss;
  const zone = optEnum(input.zone, "zone", ZONES);        if (zone !== undefined) out.zone = zone;
  const done = optBool(input.done);                       if (done !== undefined) out.done = done;
  const rpe = optInt(input.rpe, "rpe", 1, 10);            if (rpe !== undefined) out.rpe = rpe;
  if (Array.isArray(input.blocks)) {
    if (JSON.stringify(input.blocks).length > 8000) throw new BadRequest("blocks : trop volumineux");
    out.blocks = input.blocks;
  }
  return out;
}

async function createSession(sb: SupabaseClient, A: string, body: Record<string, unknown>) {
  const row = cleanSession(body, false);
  const { data, error } = await sb.from("scheduled_sessions")
    .insert({ ...row, athlete_id: A, created_by: A }).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "session.create", targetId: data.id, params: row, after: data });
  return { ok: true, session: data };
}

async function patchSession(sb: SupabaseClient, A: string, id: string | undefined, body: Record<string, unknown>) {
  if (!id) throw new BadRequest("id de séance requis");
  const { data: before } = await sb.from("scheduled_sessions").select("*").eq("athlete_id", A).eq("id", id).maybeSingle();
  if (!before) return { error: "Séance introuvable" };
  const patch = cleanSession(body, true);
  if (!Object.keys(patch).length) throw new BadRequest("Aucun champ modifiable fourni");
  const { data, error } = await sb.from("scheduled_sessions")
    .update(patch).eq("athlete_id", A).eq("id", id).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "session.update", targetId: id, params: patch, before, after: data });
  return { ok: true, session: data };
}

async function deleteSession(sb: SupabaseClient, A: string, id: string | undefined, confirm: unknown) {
  if (!id) throw new BadRequest("id de séance requis");
  if (confirm !== true && confirm !== "true") {
    return { error: "Suppression non confirmée", hint: "renvoyer confirm=true pour supprimer" };
  }
  const { data: before } = await sb.from("scheduled_sessions").select("*").eq("athlete_id", A).eq("id", id).maybeSingle();
  if (!before) return { error: "Séance introuvable" };
  const { error } = await sb.from("scheduled_sessions").delete().eq("athlete_id", A).eq("id", id);
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "session.delete", targetId: id, before });
  return { ok: true, deleted: before };
}

async function upsertCheckin(sb: SupabaseClient, A: string, dateSeg: string | undefined, body: Record<string, unknown>) {
  const date = dateSeg ? reqDate(dateSeg, "date") : iso(new Date());
  const patch: Record<string, unknown> = {};
  const sommeil = optInt(body.sommeil, "sommeil", 1, 10);        if (sommeil !== undefined) patch.sommeil = sommeil;
  const fatigue = optInt(body.fatigue, "fatigue", 1, 10);        if (fatigue !== undefined) patch.fatigue = fatigue;
  const motivation = optInt(body.motivation, "motivation", 1, 10); if (motivation !== undefined) patch.motivation = motivation;
  const poids = optNum(body.poids, "poids", 30, 150);            if (poids !== undefined) patch.poids = poids;
  const hrv = optInt(body.hrv, "hrv", 5, 250);                   if (hrv !== undefined) patch.hrv = hrv;
  if (body.dispo !== undefined && body.dispo !== null) {
    patch.dispo = reqEnum(body.dispo, "dispo", ["ok", "fatigue", "malade", "blesse"] as const);
  }
  if (typeof body.dispo_note === "string") patch.dispo_note = reqStr(body.dispo_note, "dispo_note", 500);
  if (!Object.keys(patch).length) throw new BadRequest("Aucun champ de check-in fourni");

  const { data: before } = await sb.from("checkins").select("*").eq("athlete_id", A).eq("date", date).maybeSingle();
  const { data, error } = await sb.from("checkins")
    .upsert({ athlete_id: A, date, ...patch }, { onConflict: "athlete_id,date" }).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "checkin.upsert", targetId: date, params: patch, before: before ?? null, after: data });
  return { ok: true, checkin: data };
}

async function createRecord(sb: SupabaseClient, A: string, body: Record<string, unknown>) {
  const label = reqStr(body.label, "label", 60);
  const value = reqStr(body.value, "value", 60);
  const { data, error } = await sb.from("records")
    .insert({ athlete_id: A, label, value, is_new: true }).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "record.create", targetId: data.id, params: { label, value }, after: data });
  return { ok: true, record: data };
}

const REF_FIELDS = ["ftp", "pma", "cp_bike", "vma", "cv", "seuil_run", "css", "fc_max", "fc_repos"] as const;
async function patchRefs(sb: SupabaseClient, A: string, body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const f of REF_FIELDS) {
    if (f in body) {
      const v = optNum(body[f], f, 0, 3000);
      patch[f] = v ?? null;
    }
  }
  if (!Object.keys(patch).length) throw new BadRequest(`Aucune référence fournie (${REF_FIELDS.join(", ")})`);
  const { data: before } = await sb.from("athlete_profiles").select("*").eq("user_id", A).maybeSingle();
  const { data, error } = await sb.from("athlete_profiles")
    .upsert({ user_id: A, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "refs.update", params: patch, before: before ?? null, after: data });
  return { ok: true, refs: data };
}

async function createGear(sb: SupabaseClient, A: string, body: Record<string, unknown>) {
  const type = reqEnum(body.type, "type", ["shoe", "bike"] as const);
  const name = reqStr(body.name, "name", 80);
  const row: Record<string, unknown> = { athlete_id: A, type, name };
  if (typeof body.brand === "string") row.brand = reqStr(body.brand, "brand", 60);
  const km = optNum(body.km, "km", 0, 50000);         if (km !== undefined) row.km = km;
  const max_km = optNum(body.max_km, "max_km", 1, 50000); if (max_km !== undefined) row.max_km = max_km;
  const { data, error } = await sb.from("gear").insert(row).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "gear.create", targetId: data.id, params: row, after: data });
  return { ok: true, gear: data };
}

async function patchGear(sb: SupabaseClient, A: string, id: string | undefined, body: Record<string, unknown>) {
  if (!id) throw new BadRequest("id de matériel requis");
  const patch: Record<string, unknown> = {};
  const km = optNum(body.km, "km", 0, 50000);          if (km !== undefined) patch.km = km;
  const max_km = optNum(body.max_km, "max_km", 1, 50000); if (max_km !== undefined) patch.max_km = max_km;
  const retired = optBool(body.retired);               if (retired !== undefined) patch.retired = retired;
  if (typeof body.name === "string") patch.name = reqStr(body.name, "name", 80);
  if (typeof body.brand === "string") patch.brand = reqStr(body.brand, "brand", 60);
  if (!Object.keys(patch).length) throw new BadRequest("Aucun champ de matériel fourni");
  const { data: before } = await sb.from("gear").select("*").eq("athlete_id", A).eq("id", id).maybeSingle();
  if (!before) return { error: "Matériel introuvable" };
  const { data, error } = await sb.from("gear").update(patch).eq("athlete_id", A).eq("id", id).select().single();
  if (error) throw new BadRequest(error.message);
  await logWrite(sb, { athleteId: A, op: "gear.update", targetId: id, params: patch, before, after: data });
  return { ok: true, gear: data };
}
