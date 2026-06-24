// =============================================================================
//  Edge Function : creneau-checkout
//  Paiement one-shot d'un créneau "à la carte" (price > 0, ex. Hyrox).
//  Crée une session Stripe Checkout en mode 'payment' (pas abonnement).
//  Body : { creneau_id: string, member_id: string }
//  Le webhook confirmera le paiement et marquera l'inscription 'paid'.
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { creneau_id, member_id } = await req.json();
    if (!creneau_id || !member_id) return json({ error: "creneau_id et member_id requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: creneau } = await supabase
      .from("creneaux").select("id, title, price").eq("id", creneau_id).single();
    if (!creneau) return json({ error: "Créneau introuvable" }, 404);
    if (!creneau.price || creneau.price <= 0) {
      return json({ error: "Ce créneau est gratuit (inclus dans l'adhésion)" }, 400);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: Math.round(Number(creneau.price) * 100),
          product_data: { name: `Créneau — ${creneau.title}` },
        },
      }],
      metadata: { kind: "creneau", creneau_id, member_id },
      success_url: `${APP_URL}/?creneau=paid`,
      cancel_url: `${APP_URL}/?creneau=cancel`,
    });

    // Trace le paiement en attente.
    await supabase.from("creneau_payments").insert({
      creneau_id, member_id, stripe_session_id: session.id,
      amount: creneau.price, status: "pending",
    });

    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
