// =============================================================================
//  Edge Function : garmin-webhook  (déployer avec --no-verify-jwt)
//  Garmin Activity API : "push" (données complètes) ou "ping" (URLs à puller).
//  On résout l'utilisateur par userId Garmin (= provider_user_id) et on upsert.
// =============================================================================
import { admin } from "../_shared/providers.ts";
import { garminUpsertActivities, garminGet } from "../_shared/garmin.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  let payload: any;
  try { payload = await req.json(); } catch { return new Response("ok"); }

  queueMicrotask(() => ingest(payload).catch((e) => console.error("garmin-webhook:", e)));
  return new Response("ok", { status: 200 });
});

async function ingest(payload: any) {
  const sb = admin();
  // PUSH : { activities: [ { userId, ... } ] }   |   PING : { activities:[{userId, callbackURL}] }
  const items: any[] = payload?.activities ?? payload?.activityDetails ?? [];
  // Regroupe par userId.
  const byUser = new Map<string, any[]>();
  for (const it of items) {
    const uid = it.userId;
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push(it);
  }

  for (const [garminUid, list] of byUser) {
    const { data: conn } = await sb.from("device_connections")
      .select("*").eq("provider", "garmin").eq("provider_user_id", String(garminUid)).maybeSingle();
    if (!conn) continue;

    // PING : on récupère les données via la callbackURL signée.
    const pings = list.filter((x) => x.callbackURL);
    let activities = list.filter((x) => !x.callbackURL);
    for (const p of pings) {
      try {
        const res = await garminGet(p.callbackURL, conn.access_token, conn.token_secret);
        if (res.ok) {
          const data = await res.json();
          activities = activities.concat(Array.isArray(data) ? data : (data.activities ?? []));
        }
      } catch (e) { console.error("garmin ping pull:", e); }
    }

    await garminUpsertActivities(sb, activities, conn.user_id);
    await sb.from("device_connections").update({ last_sync_at: new Date().toISOString() }).eq("id", conn.id);
  }
}
