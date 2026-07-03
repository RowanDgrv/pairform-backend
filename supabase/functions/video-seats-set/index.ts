// =============================================================================
//  Edge Function : video-seats-set
//  Le COACH active/désactive l'accès aux vidéos d'exercices pour UN athlète.
//  Facturation par SIÈGE : la quantité de l'abonnement « Vidéos » du coach est
//  synchronisée sur le nombre d'athlètes activés.
//    - 1er athlète activé, pas encore d'abo → renvoie une URL de Checkout.
//    - abo déjà actif → ajuste la quantité (pas de nouveau paiement à saisir).
//    - plus aucun athlète activé → annule l'abonnement.
//  Produit Sillance (PAS de Connect : le coach paie Sillance pour le contenu).
//
//  Body : { athlete_id: string, enabled: boolean }
//  Auth : JWT. Seul le coach (= l'appelant) agit sur SES activations.
//  L'état de facturation réel est écrit par stripe-webhook (source de vérité).
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";
const SEAT_PRICE_EUR = Number(Deno.env.get("VIDEO_SEAT_PRICE_EUR") ?? "5");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { athlete_id, enabled } = await req.json();
    if (!athlete_id) return json({ error: "athlete_id requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);
    const coachId = user.id;

    // 1) Enregistre l'activation/désactivation applicative de cet athlète.
    await supabase.from("video_access").upsert({
      coach_id: coachId,
      athlete_id,
      active: !!enabled,
      updated_at: new Date().toISOString(),
    }, { onConflict: "coach_id,athlete_id" });

    // 2) Combien d'athlètes activés au total ? = nombre de sièges à facturer.
    const { count } = await supabase.from("video_access")
      .select("id", { count: "exact", head: true })
      .eq("coach_id", coachId).eq("active", true);
    const seats = count ?? 0;

    // 3) État de facturation courant du coach.
    const { data: vs } = await supabase.from("video_seats")
      .select("*").eq("coach_id", coachId).maybeSingle();
    const hasLiveSub = vs?.stripe_subscription_id &&
      ["active", "trialing"].includes(vs.status ?? "");

    // --- Cas A : plus aucun siège → on annule l'abonnement s'il existe --------
    if (seats === 0) {
      if (hasLiveSub) {
        await stripe.subscriptions.cancel(vs!.stripe_subscription_id!);
        // le webhook (subscription.deleted) mettra status='canceled'
      }
      return json({ ok: true, seats: 0 });
    }

    // --- Cas B : abonnement déjà actif → on ajuste juste la quantité ----------
    if (hasLiveSub && vs?.stripe_item_id) {
      await stripe.subscriptions.update(vs.stripe_subscription_id!, {
        items: [{ id: vs.stripe_item_id, quantity: seats }],
        proration_behavior: "create_prorations",
      });
      // le webhook (subscription.updated) réécrira seats
      return json({ ok: true, seats });
    }

    // --- Cas C : pas d'abo actif → on ouvre un Checkout pour `seats` sièges ---
    const { data: coach } = await supabase.from("profiles")
      .select("stripe_customer_id, email, full_name").eq("id", coachId).single();

    let customerId = coach?.stripe_customer_id ?? vs?.stripe_customer_id ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: coach?.email ?? user.email,
        name: coach?.full_name ?? undefined,
        metadata: { supabase_user_id: coachId },
      });
      customerId = customer.id;
      await supabase.from("profiles")
        .update({ stripe_customer_id: customerId }).eq("id", coachId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{
        quantity: seats,
        price_data: {
          currency: "eur",
          unit_amount: Math.round(SEAT_PRICE_EUR * 100),
          recurring: { interval: "month" },
          product_data: { name: "Sillance — Vidéos d'exercices (par athlète)" },
        },
      }],
      subscription_data: { metadata: { kind: "video_seats", coach_id: coachId } },
      metadata: { kind: "video_seats", coach_id: coachId },
      allow_promotion_codes: true,
      success_url: `${APP_URL}/?videos=success`,
      cancel_url: `${APP_URL}/?videos=cancel`,
    });

    return json({ url: session.url, seats });
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
