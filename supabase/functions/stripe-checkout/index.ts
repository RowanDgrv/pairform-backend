// =============================================================================
//  Edge Function : stripe-checkout
//  Crée une session Stripe Checkout (abonnement) pour le rôle demandé.
//  Body attendu : { plan: 'coach' | 'athlete' | 'club' }
//  Auth : l'utilisateur doit être connecté (JWT Supabase dans Authorization).
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

// Mappe chaque plan vers un Price ID Stripe (à créer dans le dashboard Stripe).
const PRICE_BY_PLAN: Record<string, string | undefined> = {
  coach: Deno.env.get("STRIPE_PRICE_COACH"),
  athlete: Deno.env.get("STRIPE_PRICE_ATHLETE"),
  club: Deno.env.get("STRIPE_PRICE_CLUB"),
};

const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { plan } = await req.json();
    const priceId = PRICE_BY_PLAN[plan];
    if (!priceId) {
      return json({ error: `Plan inconnu ou Price ID manquant : ${plan}` }, 400);
    }

    // Identifie l'utilisateur via son JWT.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user }, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !user) return json({ error: "Non authentifié" }, 401);

    // Récupère (ou crée) le customer Stripe lié au profil.
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, email, full_name")
      .eq("id", user.id)
      .single();

    let customerId = profile?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile?.email ?? user.email,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await supabase.from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Métadonnées récupérées par le webhook pour écrire la bonne ligne.
      subscription_data: { metadata: { supabase_user_id: user.id, plan } },
      metadata: { supabase_user_id: user.id, plan },
      allow_promotion_codes: true,
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url: `${APP_URL}/?checkout=cancel`,
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
