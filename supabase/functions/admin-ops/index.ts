// =============================================================================
//  Edge Function : admin-ops (11/11/2026) — pilotage pour l'admin
//  Appelée toutes les 15 min par pg_cron (0096), protégée par x-cron-secret comme
//  morning-digest (déployer avec --no-verify-jwt). Trois tâches, chacune isolée :
//   1. envoie aux admins (secret ADMIN_EMAILS) les résumés du matin en attente
//      (table admin_digests, déposés par le tableau de bord local) ;
//   2. prévient les admins des nouveaux messages du formulaire de contact
//      (table support_requests) ;
//   3. rafraîchit au plus une fois par heure la photo Stripe (abonnements et
//      factures) dans admin_stripe_snapshot. Lecture seule côté Stripe.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/email.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c]);
const admins = () => (Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// deno-lint-ignore no-explicit-any
async function sendDigests(sb: any, to: string[]) {
  const { data } = await sb.from("admin_digests").select("id, subject, html").is("sent_at", null).order("id").limit(5);
  let sent = 0;
  for (const d of data ?? []) {
    let ok = to.length > 0;
    for (const a of to) ok = (await sendEmail({ to: a, subject: d.subject, html: d.html })) && ok;
    await sb.from("admin_digests").update(ok ? { sent_at: new Date().toISOString(), error: null } : { sent_at: new Date().toISOString(), error: to.length ? "envoi refusé" : "ADMIN_EMAILS vide" }).eq("id", d.id);
    if (ok) sent++;
  }
  return sent;
}

// deno-lint-ignore no-explicit-any
async function notifySupport(sb: any, to: string[]) {
  const { data } = await sb.from("support_requests").select("id, created_at, name, email, role, subject, message").is("notified_at", null).order("created_at").limit(20);
  if (!data?.length) return 0;
  const rows = data.map((r: Record<string, string>) =>
    `<div style="border:1px solid #dfe4ea;border-radius:10px;padding:12px 14px;margin:0 0 12px">
       <div style="font-weight:700">${esc(r.subject || "Contact")}</div>
       <div style="color:#687384;font-size:13px">${esc(r.name || "Sans nom")} · ${esc(r.email)}${r.role ? " · " + esc(r.role) : ""}</div>
       <p style="white-space:pre-wrap;margin:10px 0 0">${esc(r.message)}</p>
     </div>`).join("");
  const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#0f1720">
    <h2 style="margin:0 0 6px">Nouveau message du formulaire de contact</h2>
    <p style="color:#687384;margin:0 0 16px">${data.length} message${data.length > 1 ? "s" : ""} reçu${data.length > 1 ? "s" : ""} sur sillance.app. Réponds directement à l'adresse indiquée.</p>${rows}</div>`;
  let ok = to.length > 0;
  for (const a of to) ok = (await sendEmail({ to: a, subject: `Sillance : ${data.length} nouveau${data.length > 1 ? "x" : ""} message${data.length > 1 ? "s" : ""} de contact`, html })) && ok;
  // marqués même si l'e-mail échoue : ils restent visibles dans le tableau de bord, on évite les envois en boucle
  await sb.from("support_requests").update({ notified_at: new Date().toISOString() }).in("id", data.map((r: { id: string }) => r.id));
  return ok ? data.length : 0;
}

// deno-lint-ignore no-explicit-any
async function stripeSnapshot(sb: any) {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return "pas de clé Stripe";
  const { data: cur } = await sb.from("admin_stripe_snapshot").select("updated_at").eq("id", 1).maybeSingle();
  if (cur && Date.now() - new Date(cur.updated_at).getTime() < 55 * 60 * 1000) return "à jour";
  const stripe = new Stripe(key, { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });
  // deno-lint-ignore no-explicit-any
  const subs: any[] = [];
  for await (const s of stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.customer"] })) { subs.push(s); if (subs.length >= 300) break; }
  // deno-lint-ignore no-explicit-any
  const monthly = (s: any) => (s.items?.data ?? []).reduce((a: number, it: any) => {
    const p = it.price, amount = ((p?.unit_amount ?? 0) * (it.quantity ?? 1)) / 100, n = p?.recurring?.interval_count ?? 1;
    const perMonth = p?.recurring?.interval === "year" ? amount / (12 * n) : p?.recurring?.interval === "week" ? (amount * 52) / (12 * n) : p?.recurring?.interval === "day" ? (amount * 365) / (12 * n) : amount / n;
    return a + perMonth;
  }, 0);
  const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString() : null);
  // deno-lint-ignore no-explicit-any
  const who = (c: any) => (c && typeof c === "object" ? (c.name || c.email || c.id) : String(c ?? ""));
  const subscriptions = subs.map((s) => ({
    customer: who(s.customer), status: s.status, monthly: Math.round(monthly(s) * 100) / 100,
    interval: s.items?.data?.[0]?.price?.recurring?.interval ?? null, kind: s.metadata?.kind ?? s.metadata?.plan ?? null,
    created: iso(s.created), period_end: iso(s.current_period_end), cancel_at_period_end: !!s.cancel_at_period_end,
    canceled_at: iso(s.canceled_at), trial_end: iso(s.trial_end),
  }));
  // deno-lint-ignore no-explicit-any
  const invoices = (await stripe.invoices.list({ limit: 40, expand: ["data.customer"] })).data.map((i: any) => ({
    customer: who(i.customer) || i.customer_email || "", status: i.status, amount: (i.amount_due ?? 0) / 100, paid: (i.amount_paid ?? 0) / 100,
    currency: i.currency, created: iso(i.created), number: i.number, attempts: i.attempt_count ?? 0,
  }));
  const live = subscriptions.filter((s) => s.status === "active" || s.status === "past_due");
  const data = {
    livemode: subs[0]?.livemode ?? null, taken_at: new Date().toISOString(),
    mrr: Math.round(live.reduce((a, s) => a + s.monthly, 0) * 100) / 100,
    counts: { active: subscriptions.filter((s) => s.status === "active").length, trialing: subscriptions.filter((s) => s.status === "trialing").length,
      past_due: subscriptions.filter((s) => s.status === "past_due" || s.status === "unpaid").length, canceled: subscriptions.filter((s) => s.status === "canceled").length },
    subscriptions, invoices,
  };
  await sb.from("admin_stripe_snapshot").upsert({ id: 1, data, updated_at: new Date().toISOString() });
  return "rafraîchi";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const to = admins();
  const out: Record<string, unknown> = { admins: to.length };
  for (const [name, fn] of [["digests", () => sendDigests(sb, to)], ["support", () => notifySupport(sb, to)], ["stripe", () => stripeSnapshot(sb)]] as const) {
    try { out[name] = await fn(); } catch (e) { out[name] = "erreur : " + String((e as Error)?.message ?? e).slice(0, 200); console.error("[admin-ops]", name, e); }
  }
  return json(out);
});
