// =============================================================================
//  Edge Function : club-premium-subscribe
//  Un CLUB souscrit à « Sillance Premium Club » — produit Sillance (PAS de
//  Connect). Le propriétaire du club paie ; ses coachs/admins (club_members
//  role in coach,admin) héritent de la bibliothèque + Assistant IA tant que
//  clubs.premium_until court.
//
//  Body : { club_id }  — l'appelant doit être owner_id du club.
//  Auth : JWT.  L'entitlement (clubs.premium_until) est écrit par le webhook.
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";
const CLUB_PREMIUM_PRICE_EUR = Number(Deno.env.get("CLUB_PREMIUM_PRICE_EUR") ?? "79");
const CLUB_PREMIUM_PRICE_ID = Deno.env.get("STRIPE_PRICE_CLUB_PREMIUM");
const CLUB_PREMIUM_TRIAL_DAYS = Number(Deno.env.get("CLUB_PREMIUM_TRIAL_DAYS") ?? "0");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

    const { club_id } = await req.json().catch(() => ({}));
    if (!club_id) return json({ error: "club_id requis" }, 400);

    const { data: club } = await supabase
      .from("clubs").select("id, name, owner_id").eq("id", club_id).single();
    if (!club || club.owner_id !== user.id) {
      return json({ error: "Réservé au propriétaire du club" }, 403);
    }

    const { data: profile } = await supabase
      .from("profiles").select("stripe_customer_id, email, full_name").eq("id", user.id).single();

    let customerId = profile?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile?.email ?? user.email,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await supabase.from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
    }

    const line_item = CLUB_PREMIUM_PRICE_ID
      ? { price: CLUB_PREMIUM_PRICE_ID, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: Math.round(CLUB_PREMIUM_PRICE_EUR * 100),
            recurring: { interval: "month" },
            product_data: { name: `Sillance Premium Club — ${club.name}` },
          },
        };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [line_item as Stripe.Checkout.SessionCreateParams.LineItem],
      subscription_data: {
        metadata: { kind: "club_premium", club_id: club.id },
        ...(CLUB_PREMIUM_TRIAL_DAYS > 0 ? { trial_period_days: CLUB_PREMIUM_TRIAL_DAYS } : {}),
      },
      payment_method_collection: "always",
      allow_promotion_codes: true,
      success_url: `${APP_URL}/sillance-club.html?premium=success`,
      cancel_url: `${APP_URL}/sillance-club.html?premium=cancel`,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});
