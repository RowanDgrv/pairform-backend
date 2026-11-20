// =============================================================================
//  Edge Function : cron-watchdog (20/11/2026) — chien de garde des tâches auto
//  Appelée chaque heure par pg_cron (0109) et chaque jour par la routine cloud.
//  Volontairement SANS secret : la panne du 17→20/11 venait justement d'un secret
//  désynchronisé, le chien de garde ne doit pas tomber avec les tâches qu'il
//  surveille. Un appel anonyme ne peut rien faire d'autre que relancer le
//  contrôle : les mails d'alerte sont limités (même liste de problèmes → au plus
//  un mail par 24 h) et la réponse ne contient que des noms de tâches et
//  des codes HTTP.
//  Mail aux admins (secret ADMIN_EMAILS) quand cron_health() trouve un problème,
//  puis un mail « rétabli » quand tout redevient normal.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c]);
const admins = () => (Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const REALERT_MS = 24 * 3600 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: health, error } = await sb.rpc("cron_health");
    if (error) throw error;
    const problems: string[] = health?.problems ?? [];
    const signature = problems.map((p) => p.replace(/\d+ appel\(s\)|\d+ fois|\d{2}\/\d{2} \d{2}:\d{2}/g, "")).sort().join("|");

    const { data: st } = await sb.from("watchdog_state").select("last_alert_at, last_signature").eq("id", 1).single();
    const to = admins();
    let mailed: "alert" | "recovered" | null = null;

    if (problems.length) {
      const last = st?.last_alert_at ? Date.parse(st.last_alert_at) : 0;
      if (signature !== st?.last_signature || Date.now() - last > REALERT_MS) {
        const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:560px;color:#0f1720">
          <h2 style="margin:0 0 8px">Sillance : ${problems.length} tâche${problems.length > 1 ? "s" : ""} automatique${problems.length > 1 ? "s" : ""} en panne</h2>
          <p>Le chien de garde a trouvé :</p>
          <ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
          <p style="color:#5b6670;font-size:13px">Contrôle : cron_health() en base. Tant que rien ne change, ce mail revient au plus une fois par 24 h.</p></div>`;
        let ok = to.length > 0;
        for (const a of to) ok = (await sendEmail({ to: a, subject: `⚠ Sillance : tâches automatiques en panne (${problems.length})`, html })) && ok;
        if (ok) {
          await sb.from("watchdog_state").update({ last_alert_at: new Date().toISOString(), last_signature: signature }).eq("id", 1);
          mailed = "alert";
        } else console.error("cron-watchdog : alerte non envoyée (ADMIN_EMAILS ou Resend)");
      }
    } else {
      if (st?.last_signature) {
        let ok = to.length > 0;
        for (const a of to) ok = (await sendEmail({ to: a, subject: "Sillance : tâches automatiques rétablies", html: `<div style="font-family:system-ui,sans-serif">Tout est revenu à la normale : plus aucun problème détecté par le chien de garde.</div>` })) && ok;
        if (ok) mailed = "recovered";
      }
      await sb.from("watchdog_state").update({ last_ok_at: new Date().toISOString(), ...(mailed ? { last_signature: null } : {}) }).eq("id", 1);
    }
    return json({ ok: problems.length === 0, problems, mailed, checked_at: health?.checked_at });
  } catch (e) {
    console.error(e);
    return json({ ok: false, problems: ["cron-watchdog : erreur interne"] }, 500);
  }
});
