// =============================================================================
//  Edge Function : club-subscribe
//  Abonne un MEMBRE à une FORMULE CLUB récurrente : 'sub' (Abonnement club) ou
//  'coach' (Coaching +). Crée une session Stripe Checkout en mode 'subscription'
//  avec un prix dynamique (le club édite ses tarifs → pas de Price ID fixe).
//
//  CONNECT-READY : si le club a relié son compte Stripe (charges_enabled),
//  l'encaissement est routé vers le club (destination charges) avec commission
//  plateforme PLATFORM_FEE_PERCENT ; sinon fallback → PairForm encaisse (démo).
//
//  « À la séance » (dropin, one-shot) reste géré par creneau-checkout.
//
//  Body : { club_id: string, member_id: string, tier: 'sub' | 'coach' }
//  Auth : JWT Supabase. Autorisé si l'appelant est le gérant du club OU le membre.
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

const TIER_LABEL: Record<string, string> = {
  sub: "Abonnement club",
  coach: "Coaching +",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { club_id, member_id, tier } = await req.json();
    if (!club_id || !member_id || !["sub", "coach"].includes(tier)) {
      return json({ error: "club_id, member_id et tier ('sub'|'coach') requis" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    // --- club + autorisation -------------------------------------------------
    const { data: club } = await supabase
      .from("clubs")
      .select("id, name, owner_id, stripe_account_id, charges_enabled")
      .eq("id", club_id).single();
    if (!club) return json({ error: "Club introuvable" }, 404);

    const { data: member } = await supabase
      .from("club_members")
      .select("id, athlete_id, display_name")
      .eq("id", member_id).eq("club_id", club_id).single();
    if (!member) return json({ error: "Membre introuvable" }, 404);

    const isOwner = club.owner_id === user.id;
    const isSelf = member.athlete_id === user.id;
    if (!isOwner && !isSelf) return json({ error: "Non autorisé" }, 403);

    // --- tarif de la formule (édité par le club) -----------------------------
    const { data: offer } = await supabase
      .from("club_offers")
      .select("price, bill_interval, active")
      .eq("club_id", club_id).eq("tier", tier).single();
    if (!offer || offer.active === false) return json({ error: "Formule indisponible" }, 400);

    // --- customer Stripe lié au payeur (le membre s'il a un compte) -----------
    const payerId = member.athlete_id ?? user.id;
    const { data: payer } = await supabase
      .from("profiles")
      .select("stripe_customer_id, email, full_name")
      .eq("id", payerId).single();

    let customerId = payer?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: payer?.email ?? user.email,
        name: payer?.full_name ?? member.display_name ?? undefined,
        metadata: { supabase_user_id: payerId },
      });
      customerId = customer.id;
      await supabase.from("profiles")
        .update({ stripe_customer_id: customerId }).eq("id", payerId);
    }

    // --- Connect : routage vers le club si relié, sinon PairForm encaisse -----
    const connected = !!club.stripe_account_id && club.charges_enabled === true;
    const subscription_data: Record<string, unknown> = {
      metadata: { kind: "club_membership", club_id, member_id, tier },
    };
    if (connected) {
      subscription_data.transfer_data = { destination: club.stripe_account_id };
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
          product_data: { name: `${club.name} — ${TIER_LABEL[tier]}` },
        },
      }],
      subscription_data,
      metadata: { kind: "club_membership", club_id, member_id, tier },
      allow_promotion_codes: true,
      success_url: `${APP_URL}/?club_sub=success`,
      cancel_url: `${APP_URL}/?club_sub=cancel`,
    });

    // L'adhésion réelle sera écrite par le webhook (source de vérité).
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
