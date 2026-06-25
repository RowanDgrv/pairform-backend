// =============================================================================
//  Edge Function : coach-connect
//  Onboarding Stripe Connect (compte Express) d'un COACH solo, pour qu'il
//  encaisse lui-même ses athlètes. Crée le compte connecté s'il n'existe pas,
//  puis renvoie un lien d'onboarding Stripe.
//
//  Miroir de club-connect, mais au niveau du PROFIL (pas d'un club).
//  `charges_enabled` est mis à jour par le webhook (account.updated).
//
//  Body : {} (le coach connecté). Auth : JWT Supabase.
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5500";
const COUNTRY = Deno.env.get("STRIPE_CONNECT_COUNTRY") ?? "FR";

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
      .from("profiles")
      .select("id, full_name, email, stripe_account_id")
      .eq("id", user.id).single();

    // Crée le compte connecté Express si besoin.
    let accountId = profile?.stripe_account_id as string | null | undefined;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: COUNTRY,
        business_type: "individual",
        email: profile?.email ?? user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: { name: profile?.full_name ?? undefined },
        metadata: { supabase_user_id: user.id, kind: "coach" },
      });
      accountId = account.id;
      await supabase.from("profiles")
        .update({ stripe_account_id: accountId }).eq("id", user.id);
    }

    // Lien d'onboarding (à ouvrir par le coach pour compléter ses infos KYC).
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${APP_URL}/?coach_connect=refresh`,
      return_url: `${APP_URL}/?coach_connect=done`,
      type: "account_onboarding",
    });

    return json({ url: link.url, account_id: accountId });
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
