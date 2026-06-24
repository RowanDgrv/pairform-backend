// =============================================================================
//  Edge Function : stripe-portal
//  Ouvre le Customer Portal Stripe (gérer / annuler / changer de carte).
//  Auth : utilisateur connecté.
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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: profile } = await supabase
      .from("profiles").select("stripe_customer_id").eq("id", user.id).single();
    if (!profile?.stripe_customer_id) {
      return json({ error: "Aucun client Stripe" }, 400);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${APP_URL}/?portal=return`,
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
