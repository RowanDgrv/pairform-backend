// =============================================================================
//  Edge Function : premium-subscribe
//  Le COACH souscrit à « Sillance Premium » — produit Sillance (PAS de Connect,
//  c'est Sillance qui encaisse). Débloque :
//    • la bibliothèque de 100 séances (library_sessions, RLS my_library_access) ;
//    • l'Assistant IA (has_ai_addon devient vrai via has_premium).
//
//  Body : {}  — le payeur = l'utilisateur connecté.
//  Auth : JWT.  L'entitlement réel (coach_premium) est écrit par le webhook.
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";
const PREMIUM_PRICE_EUR = Number(Deno.env.get("PREMIUM_PRICE_EUR") ?? "29");
const PREMIUM_PRICE_ID = Deno.env.get("STRIPE_PRICE_PREMIUM");        // optionnel : Price fixe
const PREMIUM_TRIAL_DAYS = Number(Deno.env.get("PREMIUM_TRIAL_DAYS") ?? "14");

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

    const { data: profile } = await supabase
      .from("profiles").select("stripe_customer_id, email, full_name, staff").eq("id", user.id).single();

    if (profile?.staff) return json({ error: "Compte Sillance : Premium déjà inclus" }, 400);

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

    const line_item = PREMIUM_PRICE_ID
      ? { price: PREMIUM_PRICE_ID, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: Math.round(PREMIUM_PRICE_EUR * 100),
            recurring: { interval: "month" },
            product_data: { name: "Sillance Premium — bibliothèque de séances + Assistant IA" },
          },
        };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [line_item as Stripe.Checkout.SessionCreateParams.LineItem],
      subscription_data: {
        metadata: { kind: "coach_premium", user_id: user.id },
        ...(PREMIUM_TRIAL_DAYS > 0 ? { trial_period_days: PREMIUM_TRIAL_DAYS } : {}),
      },
      payment_method_collection: "always",
      allow_promotion_codes: true,
      success_url: `${APP_URL}/sillance-app.html?premium=success`,
      cancel_url: `${APP_URL}/sillance-app.html?premium=cancel`,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
});
