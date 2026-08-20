// =============================================================================
//  Edge Function : coach-alert-on-checkin
//  Portage serveur de la condition d'alerte déjà présente côté client dans
//  notifyCoach()/submitCheckin() (sillance-calendrier.core.js) : un check-in
//  faible/blessé déclenche une notification push vers le coach de l'athlète,
//  pour de vrai (pas juste une notification locale sur l'appareil de
//  l'athlète comme le fait le repli client actuel).
//
//  Déclencheur : trigger Postgres AFTER INSERT/UPDATE sur checkins (voir
//  migration 0038) → POST { checkin_id }, header x-cron-secret (même secret
//  que morning-digest, réutilisé ici pour ne pas multiplier les secrets).
//
//  Seuils repris de submitCheckin() : score < 50 (vigilance) ou < 30
//  (urgent), dispo 'blesse' (urgent) ou tout dispo != 'ok' (vigilance).
//  Le volet HRV du client (ATHLETE_REF.hrvBase) n'est PAS répliqué ici :
//  c'est une valeur démo côté client, il n'existe aujourd'hui aucune colonne
//  de référence HRV persistée par athlète — condition sciemment omise plutôt
//  que mal reproduite (voir audit app mobile 05/08/2026, à traiter dans une
//  migration séparée si une baseline HRV est un jour vraiment stockée).
//
//  Secrets : CRON_SECRET (partagé avec morning-digest), VAPID_KEYS_JSON,
//            VAPID_SUBJECT, FCM_SERVICE_ACCOUNT_JSON (voir _shared/fcm.ts).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendFcmPush } from "../_shared/fcm.ts";
import { sendApnsPush } from "../_shared/apns.ts";

const CHECKIN_THRESHOLD = 50; // seuil orange (vigilance) — identique à submitCheckin()
const CHECKIN_URGENT = 30; // seuil rouge (urgent)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const secret = Deno.env.get("CRON_SECRET") ?? "";
    if (!secret || req.headers.get("x-cron-secret") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }

    const { checkin_id } = await req.json().catch(() => ({}));
    if (!checkin_id) return json({ error: "checkin_id manquant" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: ci, error: ciErr } = await supabase
      .from("checkins")
      .select("athlete_id, readiness, dispo, sommeil, fatigue, motivation")
      .eq("id", checkin_id)
      .single();
    if (ciErr || !ci) return json({ ok: true, skipped: "checkin introuvable" });

    const score = ci.readiness ?? 100;
    const dispo = ci.dispo ?? "ok";
    const low = score < CHECKIN_THRESHOLD || dispo !== "ok";
    const urgent = score < CHECKIN_URGENT || dispo === "blesse";
    if (!low) return json({ ok: true, skipped: "check-in dans la norme" });

    // coach actif de cet athlète (un seul dans l'usage courant — coach_athlete.status='active')
    const { data: link } = await supabase
      .from("coach_athlete")
      .select("coach_id")
      .eq("athlete_id", ci.athlete_id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (!link?.coach_id) return json({ ok: true, skipped: "pas de coach actif" });

    const { data: athlete } = await supabase
      .from("profiles").select("full_name").eq("id", ci.athlete_id).single();
    const athleteName = athlete?.full_name ?? "Un athlète";

    const title = `${urgent ? "🔴 Urgent" : "🟠 Vigilance"} — ${athleteName} (${score}%)`;
    const body = `Sommeil ${ci.sommeil ?? "?"}/10 · Fatigue ${ci.fatigue ?? "?"}/10 · Motivation ${
      ci.motivation ?? "?"
    }/10${dispo !== "ok" ? ` · ${dispo}` : ""}`;

    let appServer: webpush.ApplicationServer | null = null;
    const vapidJson = Deno.env.get("VAPID_KEYS_JSON");
    if (vapidJson) {
      const vapidKeys = await webpush.importVapidKeys(JSON.parse(vapidJson), { extractable: false });
      appServer = await webpush.ApplicationServer.new({
        contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:rowandegraeve@gmail.com",
        vapidKeys,
      });
    }

    const { data: subs } = await supabase.from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, platform").eq("user_id", link.coach_id);

    // Lu côté client au tap sur la notification (silOnNotificationTap,
    // sillance-calendrier.core.js) pour amener directement le coach sur le
    // panneau d'alertes plutôt que sur l'écran par défaut de l'app.
    const pushData = { type: "coach_alert", athlete_id: ci.athlete_id };

    let sent = 0;
    for (const s of subs ?? []) {
      if (s.platform === "android") {
        const r = await sendFcmPush(s.endpoint, { title, body, data: pushData });
        if (r.ok) sent++;
        else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
        continue;
      }
      if (s.platform === "ios") {
        const r = await sendApnsPush(s.endpoint, { title, body, data: pushData });
        if (r.ok) sent++;
        else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
        continue;
      }
      if (!appServer) continue;
      try {
        const subscriber = appServer.subscribe({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        });
        await subscriber.pushTextMessage(JSON.stringify({ title, body }), {});
        sent++;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("404") || msg.includes("410")) {
          await supabase.from("push_subscriptions").delete().eq("id", s.id);
        } else console.warn("push coach KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
      }
    }

    return json({ ok: true, urgent, sent });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
