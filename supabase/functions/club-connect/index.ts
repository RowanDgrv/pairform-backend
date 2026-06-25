// =============================================================================
//  Edge Function : club-connect
//  Démarre l'onboarding Stripe Connect (compte Express) d'un club, pour qu'il
//  encaisse LUI-MÊME les paiements de ses adhérents. Crée le compte connecté
//  s'il n'existe pas encore, puis renvoie un lien d'onboarding Stripe.
//
//  Le statut `charges_enabled` est mis à jour par le webhook (account.updated).
//  Tant qu'il est false, club-subscribe fait le fallback (PairForm encaisse).
//
//  Body : { club_id: string }
//  Auth : JWT Supabase. Réservé au gérant (owner) du club.
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
    const { club_id } = await req.json();
    if (!club_id) return json({ error: "club_id requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: club } = await supabase
      .from("clubs")
      .select("id, name, owner_id, stripe_account_id")
      .eq("id", club_id).single();
    if (!club) return json({ error: "Club introuvable" }, 404);
    if (club.owner_id !== user.id) return json({ error: "Réservé au gérant du club" }, 403);

    // Crée le compte connecté Express si besoin.
    let accountId = club.stripe_account_id as string | null;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: COUNTRY,
        business_type: "individual",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: { name: club.name },
        metadata: { club_id, supabase_user_id: user.id },
      });
      accountId = account.id;
      await supabase.from("clubs")
        .update({ stripe_account_id: accountId }).eq("id", club_id);
    }

    // Lien d'onboarding (à ouvrir par le gérant pour compléter ses infos KYC).
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${APP_URL}/?club_connect=refresh`,
      return_url: `${APP_URL}/?club_connect=done`,
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
