// =============================================================================
//  Edge Function : coach-invoices
//  Liste les factures Stripe des abonnements « coaching_subscriptions » d'un
//  coach (un athlète qui paie son suivi) : montant, athlète, date, PDF.
//  Ces factures sont un sous-produit natif de Stripe (créées automatiquement
//  à chaque échéance de l'abonnement) — on ne stocke rien nous-mêmes, on les
//  relit à la demande via l'API Stripe pour chaque abonnement du coach.
//
//  Body : {} — le coach connecté (JWT) voit ses propres factures.
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const FEE_PERCENT = Number(Deno.env.get("PLATFORM_FEE_PERCENT") ?? "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    // Abonnements de coaching où l'appelant est le COACH (jamais l'athlète : on
    // ne veut pas exposer les factures d'un coach à ses propres athlètes).
    const { data: subs } = await supabase
      .from("coaching_subscriptions")
      .select("athlete_id, offer_id, stripe_subscription_id, coach_offers(name)")
      .eq("coach_id", user.id)
      .not("stripe_subscription_id", "is", null);

    if (!subs || subs.length === 0) return json({ invoices: [] });

    const athleteIds = [...new Set(subs.map((s) => s.athlete_id))];
    const { data: athletes } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", athleteIds);
    const athleteById = new Map((athletes ?? []).map((a) => [a.id, a]));

    const invoices: Record<string, unknown>[] = [];
    for (const sub of subs) {
      const athlete = athleteById.get(sub.athlete_id);
      const list = await stripe.invoices.list({
        subscription: sub.stripe_subscription_id,
        limit: 24,
        expand: ["data.charge"],
      });
      for (const inv of list.data) {
        const charge = inv.charge as Stripe.Charge | null;
        const feeAmount = charge && typeof charge !== "string"
          ? charge.application_fee_amount ?? null
          : null;
        invoices.push({
          invoice_id: inv.id,
          number: inv.number,
          status: inv.status,
          athlete_name: athlete?.full_name ?? "Athlète",
          athlete_email: athlete?.email ?? null,
          offer_name: (sub as { coach_offers?: { name?: string } }).coach_offers?.name ?? "Suivi coaching",
          amount_paid: (inv.amount_paid ?? 0) / 100,
          currency: inv.currency,
          fee_amount: feeAmount != null ? feeAmount / 100 : null,
          fee_percent: FEE_PERCENT,
          created: new Date(inv.created * 1000).toISOString(),
          hosted_invoice_url: inv.hosted_invoice_url,
          invoice_pdf: inv.invoice_pdf,
        });
      }
    }

    invoices.sort((a, b) => (b.created as string).localeCompare(a.created as string));
    return json({ invoices });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
