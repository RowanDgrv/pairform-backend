// =============================================================================
//  Edge Function : coach-subscribe
//  Un ATHLÈTE s'abonne au SUIVI d'un COACH (abonnement mensuel récurrent).
//  Boucle la boucle avec coach-connect : le coach a relié son compte Stripe,
//  l'athlète paie ici → l'argent va au coach (destination charges) si relié,
//  sinon fallback PairForm encaisse (démo). Prix dynamique (coach_offers).
//
//  Body : { coach_id: string, athlete_id?: string, offer_id?: string }
//    - athlete_id par défaut = l'utilisateur connecté (auto-abonnement).
//    - offer_id par défaut = la 1re offre active du coach.
//  Auth : JWT. Autorisé si l'appelant est le coach OU l'athlète concerné.
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";
const FEE_PERCENT = Number(Deno.env.get("PLATFORM_FEE_PERCENT") ?? "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { coach_id, athlete_id, offer_id } = await req.json();
    if (!coach_id) return json({ error: "coach_id requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const athleteId = athlete_id ?? user.id;
    // Autorisé : le coach lui-même ou l'athlète concerné.
    if (user.id !== coach_id && user.id !== athleteId) {
      return json({ error: "Non autorisé" }, 403);
    }

    // --- coach (compte Connect) ----------------------------------------------
    const { data: coach } = await supabase
      .from("profiles")
      .select("id, full_name, stripe_account_id, charges_enabled")
      .eq("id", coach_id).single();
    if (!coach) return json({ error: "Coach introuvable" }, 404);

    // --- offre de coaching (tarif éditable par le coach) ---------------------
    let offerQuery = supabase.from("coach_offers")
      .select("id, name, price, active").eq("coach_id", coach_id);
    offerQuery = offer_id ? offerQuery.eq("id", offer_id) : offerQuery.eq("active", true);
    const { data: offers } = await offerQuery.limit(1);
    const offer = offers?.[0];
    if (!offer || offer.active === false) return json({ error: "Offre de coaching indisponible" }, 400);

    // --- customer Stripe de l'athlète (le payeur) ----------------------------
    const { data: payer } = await supabase
      .from("profiles")
      .select("stripe_customer_id, email, full_name")
      .eq("id", athleteId).single();

    let customerId = payer?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: payer?.email ?? user.email,
        name: payer?.full_name ?? undefined,
        metadata: { supabase_user_id: athleteId },
      });
      customerId = customer.id;
      await supabase.from("profiles")
        .update({ stripe_customer_id: customerId }).eq("id", athleteId);
    }

    // --- Connect : routage vers le coach si relié, sinon PairForm encaisse ----
    const connected = !!coach.stripe_account_id && coach.charges_enabled === true;
    const subscription_data: Record<string, unknown> = {
      metadata: { kind: "coaching_subscription", coach_id, athlete_id: athleteId, offer_id: offer.id },
    };
    if (connected) {
      subscription_data.transfer_data = { destination: coach.stripe_account_id };
      if (FEE_PERCENT > 0) subscription_data.application_fee_percent = FEE_PERCENT;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: Math.round(Number(offer.price) * 100),
          recurring: { interval: "month" },
          product_data: { name: `${offer.name} — ${coach.full_name ?? "Coach"}` },
        },
      }],
      subscription_data,
      metadata: { kind: "coaching_subscription", coach_id, athlete_id: athleteId, offer_id: offer.id },
      allow_promotion_codes: true,
      success_url: `${APP_URL}/?coaching=success`,
      cancel_url: `${APP_URL}/?coaching=cancel`,
    });

    // L'abonnement réel sera écrit par le webhook (source de vérité).
    return json({ url: session.url, connected });
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
