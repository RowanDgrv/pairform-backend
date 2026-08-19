// =============================================================================
//  Edge Function : notify-week-ready
//  Le coach vient de planifier la semaine d'un athlète et coche "prévenir
//  [athlète] que sa semaine est prête" (case dans la bannière coach du
//  calendrier, sillance-app.core.js renderCoachBand). Envoie un push avec un
//  résumé chiffré (nb séances · durée · charge) directement à l'athlète.
//
//  Body : { athlete_id: string, week_monday: string (YYYY-MM-DD) }
//  Auth : JWT du coach. Vérifie que l'appelant EST bien le coach actif de cet
//  athlète (requête directe sur coach_athlete, pas is_coach_of : cette RPC
//  s'appuie sur auth.uid(), qui vaut NULL sous la clé service_role — même
//  garde que video-seats-set).
//
//  Secrets : VAPID_KEYS_JSON, VAPID_SUBJECT, FCM_SERVICE_ACCOUNT_JSON,
//            APNS_* (voir _shared/fcm.ts, _shared/apns.ts).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendFcmPush } from "../_shared/fcm.ts";
import { sendApnsPush } from "../_shared/apns.ts";

function fmtDur(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { athlete_id, week_monday } = await req.json();
    if (!athlete_id || !week_monday) return json({ error: "athlete_id et week_monday requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);
    const coachId = user.id;

    const { data: rel } = await supabase.from("coach_athlete")
      .select("id").eq("coach_id", coachId).eq("athlete_id", athlete_id).eq("status", "active").maybeSingle();
    if (!rel) return json({ error: "Cet athlète n'est pas dans ton roster" }, 403);

    const weekEnd = new Date(week_monday + "T00:00:00Z");
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const { data: sessions, error: sErr } = await supabase.from("scheduled_sessions")
      .select("dur, tss").eq("athlete_id", athlete_id)
      .gte("date", week_monday).lte("date", weekEnd.toISOString().slice(0, 10));
    if (sErr) throw sErr;
    if (!sessions?.length) return json({ ok: true, skipped: "aucune séance sur cette semaine" });

    const totalDur = sessions.reduce((s, x) => s + (x.dur ?? 0), 0);
    const totalTss = sessions.reduce((s, x) => s + (x.tss ?? 0), 0);
    const { data: coach } = await supabase.from("profiles").select("full_name").eq("id", coachId).single();

    const weekLabel = new Date(week_monday + "T00:00:00Z")
      .toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
    const title = `Ta semaine du ${weekLabel} est prête`;
    const bodyTxt = `${sessions.length} séance${sessions.length > 1 ? "s" : ""} · ${fmtDur(totalDur)}` +
      (totalTss ? ` · ${totalTss} TSS` : "") +
      (coach?.full_name ? ` — préparée par ${coach.full_name}` : "");

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
      .select("id, endpoint, p256dh, auth, platform").eq("user_id", athlete_id);
    // Lu côté client au tap (silOnNotificationTap) pour amener l'athlète direct sur sa semaine.
    const pushData = { type: "week_ready", week_monday };

    let sent = 0;
    for (const s of subs ?? []) {
      if (s.platform === "android") {
        const r = await sendFcmPush(s.endpoint, { title, body: bodyTxt, data: pushData });
        if (r.ok) sent++;
        else if (r.deadToken) await supabase.from("push_subscriptions").delete().eq("id", s.id);
        continue;
      }
      if (s.platform === "ios") {
        const r = await sendApnsPush(s.endpoint, { title, body: bodyTxt, data: pushData });
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
        await subscriber.pushTextMessage(JSON.stringify({
          title, body: bodyTxt, url: "./sillance-app.html",
        }), {});
        sent++;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("404") || msg.includes("410")) {
          await supabase.from("push_subscriptions").delete().eq("id", s.id);
        } else console.warn("push week-ready KO:", s.endpoint.slice(0, 40), msg.slice(0, 120));
      }
    }

    return json({ ok: true, sent, sessions: sessions.length, dur: totalDur, tss: totalTss });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
