// =============================================================================
//  Edge Function : stripe-checkout
//  Crée une session Stripe Checkout (abonnement) pour le rôle demandé.
//  Body attendu : { plan: 'coach' | 'athlete' | 'club', tier?: 1|2|3 }
//  - plan==='coach' : 3 paliers auto-déclarés selon le nombre d'athlètes
//    coachés (1-10 / 11-30 / 31+), prix dynamique (price_data), pas de
//    Price ID Stripe fixe à créer/maintenir.
//  - athlete/club : inchangé, Price ID fixe via env (legacy, peu utilisé —
//    ces 2 rôles ont chacun leur propre edge function dédiée par ailleurs).
//  Auth : l'utilisateur doit être connecté (JWT Supabase dans Authorization).
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

// Mappe chaque plan (hors coach) vers un Price ID Stripe fixe.
const PRICE_BY_PLAN: Record<string, string | undefined> = {
  athlete: Deno.env.get("STRIPE_PRICE_ATHLETE"),
  club: Deno.env.get("STRIPE_PRICE_CLUB"),
};

// Paliers coach : 1 = 1-10 athlètes, 2 = 11-30, 3 = 31+.
const COACH_TIERS: Record<number, { price: number; label: string }> = {
  1: { price: Number(Deno.env.get("COACH_TIER1_PRICE_EUR") ?? "19"), label: "1 à 10 athlètes" },
  2: { price: Number(Deno.env.get("COACH_TIER2_PRICE_EUR") ?? "29"), label: "11 à 30 athlètes" },
  3: { price: Number(Deno.env.get("COACH_TIER3_PRICE_EUR") ?? "49"), label: "31+ athlètes" },
};

const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { plan, tier } = await req.json();

    let lineItem: Stripe.Checkout.SessionCreateParams.LineItem;
    let coachTier: number | null = null;

    if (plan === "coach") {
      coachTier = [1, 2, 3].includes(Number(tier)) ? Number(tier) : 1;
      const t = COACH_TIERS[coachTier];
      lineItem = {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: Math.round(t.price * 100),
          recurring: { interval: "month" },
          product_data: { name: `Sillance — Abonnement Coach (${t.label})` },
        },
      };
    } else {
      const priceId = PRICE_BY_PLAN[plan];
      if (!priceId) {
        return json({ error: `Plan inconnu ou Price ID manquant : ${plan}` }, 400);
      }
      lineItem = { price: priceId, quantity: 1 };
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

    const subMeta: Record<string, string> = { supabase_user_id: user.id, plan };
    if (coachTier != null) subMeta.tier = String(coachTier);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [lineItem],
      // Métadonnées récupérées par le webhook pour écrire la bonne ligne.
      subscription_data: { metadata: subMeta },
      metadata: subMeta,
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
