// =============================================================================
//  Edge Function : garmin-webhook  (déployer avec --no-verify-jwt)
//  Garmin Activity API : "push" (données complètes) ou "ping" (URLs à puller).
//  On résout l'utilisateur par userId Garmin (= provider_user_id) et on upsert.
// =============================================================================
import { admin } from "../_shared/providers.ts";
import { garminImportRecent } from "../_shared/garmin.ts";

// Global injecté par le runtime Supabase Edge Functions (Deno Deploy), absent
// des types Deno standards — `deno check` en CI (sans ce runtime) ne le
// connaît pas sans cette déclaration ambiante.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  let payload: any;
  try { payload = await req.json(); } catch { return new Response("ok"); }

  // EdgeRuntime.waitUntil (pas queueMicrotask) : garantit que le runtime garde
  // l'isolate vivant jusqu'à la fin du traitement en arrière-plan, même après
  // que la réponse HTTP ci-dessous soit déjà partie (constat audit 03/08/2026).
  EdgeRuntime.waitUntil(ingest(payload).catch((e) => console.error("garmin-webhook:", e)));
  return new Response("ok", { status: 200 });
});

async function ingest(payload: any) {
  const sb = admin();
  // ⚠️ SÉCURITÉ : le webhook n'est pas authentifié et Garmin ne signe pas ses
  // pushes → on NE FAIT PAS confiance aux champs d'activité du payload (un
  // pirate connaissant le userId Garmin d'un athlète pourrait y injecter un
  // nom d'activité arbitraire, y compris du HTML/JS, rendu ensuite sans
  // échappement côté app). Même pattern que Strava/Coros : le payload sert
  // UNIQUEMENT de déclencheur ; les données réelles sont RE-TÉLÉCHARGÉES via
  // l'API Garmin authentifiée avec le jeton stocké (garminImportRecent).
  // PUSH : { activities: [ { userId, ... } ] }   |   PING : { activities:[{userId, callbackURL}] }
  const items: any[] = payload?.activities ?? payload?.activityDetails ?? [];
  const garminUids = new Set<string>();
  for (const it of items) {
    if (it?.userId) garminUids.add(String(it.userId));
  }

  for (const garminUid of garminUids) {
    const { data: conn } = await sb.from("device_connections")
      .select("*").eq("provider", "garmin").eq("provider_user_id", garminUid).maybeSingle();
    if (!conn) continue;
    try { await garminImportRecent(sb, conn); } catch (e) { console.error("garmin re-fetch:", e); }
  }
}
