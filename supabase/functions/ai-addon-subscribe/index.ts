// =============================================================================
//  Edge Function : ai-addon-subscribe
//  Le COACH active l'add-on « Assistant IA » (~12 €/mois) — produit Sillance,
//  donc PAS de Connect : c'est Sillance qui encaisse (contrairement à
//  coach-subscribe où l'argent va au coach).
//
//  Body : {} (le payeur = l'utilisateur connecté)
//  Auth : JWT.
//  L'entitlement réel (table ai_addons) est écrit par le webhook (vérité).
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";
const AI_PRICE_EUR = Number(Deno.env.get("AI_ADDON_PRICE_EUR") ?? "12");
const AI_PRICE_ID = Deno.env.get("STRIPE_PRICE_AI"); // optionnel : Price fixe

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

    // --- customer Stripe du coach ---
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, email, full_name")
      .eq("id", user.id).single();

    let customerId = profile?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile?.email ?? user.email,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await supabase.from("profiles")
        .update({ stripe_customer_id: customerId }).eq("id", user.id);
    }

    // --- ligne : Price fixe si configuré, sinon price_data dynamique ---
    const line_item = AI_PRICE_ID
      ? { price: AI_PRICE_ID, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: Math.round(AI_PRICE_EUR * 100),
            recurring: { interval: "month" },
            product_data: { name: "Sillance — Assistant IA (add-on coach)" },
          },
        };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [line_item as Stripe.Checkout.SessionCreateParams.LineItem],
      subscription_data: { metadata: { kind: "ai_addon", user_id: user.id } },
      allow_promotion_codes: true,
      success_url: `${APP_URL}/?ai=success`,
      cancel_url: `${APP_URL}/?ai=cancel`,
    });

    return json({ url: session.url });
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
