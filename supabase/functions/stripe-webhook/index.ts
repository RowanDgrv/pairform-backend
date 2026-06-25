// =============================================================================
//  Edge Function : stripe-webhook
//  Source de vérité de l'abonnement : Stripe pousse les événements ici, on
//  synchronise la table `subscriptions`. NE JAMAIS faire confiance au front
//  pour décider qu'un user est abonné — c'est ce webhook qui fait foi.
//
//  IMPORTANT : déployer cette fonction avec --no-verify-jwt (Stripe n'envoie
//  pas de JWT Supabase, il signe avec STRIPE_WEBHOOK_SECRET).
// =============================================================================
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // service_role : contourne la RLS
);

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error("Signature invalide :", err);
    return new Response("Bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await upsertSubscription(sub);
        break;
      }
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Abonnement (coach / athlete / club)
        if (session.mode === "subscription" && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(
            session.subscription as string,
          );
          await upsertSubscription(sub);
        }
        // Paiement one-shot d'un créneau à la carte
        if (session.mode === "payment" && session.metadata?.kind === "creneau") {
          await confirmCreneauPayment(session);
        }
        break;
      }
      // Connect : un club OU un coach a (dé)complété son onboarding.
      // On met à jour les deux tables ; celle qui ne correspond pas touche 0 ligne.
      case "account.updated": {
        const acct = event.data.object as Stripe.Account;
        const enabled = acct.charges_enabled ?? false;
        const r1 = await supabase.from("clubs")
          .update({ charges_enabled: enabled }).eq("stripe_account_id", acct.id);
        const r2 = await supabase.from("profiles")
          .update({ charges_enabled: enabled }).eq("stripe_account_id", acct.id);
        if (r1.error) console.error("MAJ charges_enabled club échouée :", r1.error);
        if (r2.error) console.error("MAJ charges_enabled coach échouée :", r2.error);
        break;
      }
      default:
        // autres événements ignorés
        break;
    }
  } catch (e) {
    console.error("Erreur traitement webhook :", e);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});

async function upsertSubscription(sub: Stripe.Subscription) {
  // Une adhésion à une formule club est routée vers sa propre table.
  if (sub.metadata?.kind === "club_membership") {
    return await upsertClubMembership(sub);
  }

  const userId = sub.metadata?.supabase_user_id;
  const plan = sub.metadata?.plan ?? "athlete";
  if (!userId) {
    console.warn("Subscription sans supabase_user_id :", sub.id);
    return;
  }

  const row = {
    user_id: userId,
    plan,
    stripe_customer_id: sub.customer as string,
    stripe_subscription_id: sub.id,
    price_id: sub.items.data[0]?.price?.id ?? null,
    status: sub.status,
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    cancel_at_period_end: sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("subscriptions")
    .upsert(row, { onConflict: "stripe_subscription_id" });

  if (error) console.error("Upsert subscription échoué :", error);
}

// Adhésion d'un membre à une formule club (sub | coach) : la source de vérité
// est ici. Métadonnées posées par club-subscribe : { kind, club_id, member_id, tier }.
async function upsertClubMembership(sub: Stripe.Subscription) {
  const m = sub.metadata ?? {};
  if (!m.club_id || !m.member_id) {
    console.warn("Adhésion club sans club_id/member_id :", sub.id);
    return;
  }

  const row = {
    club_id: m.club_id,
    member_id: m.member_id,
    tier: m.tier ?? "sub",
    status: sub.status,
    stripe_customer_id: sub.customer as string,
    stripe_subscription_id: sub.id,
    price_id: sub.items.data[0]?.price?.id ?? null,
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    cancel_at_period_end: sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("club_memberships")
    .upsert(row, { onConflict: "stripe_subscription_id" });

  if (error) console.error("Upsert club_membership échoué :", error);
}

// Confirme le paiement d'un créneau à la carte : marque le paiement 'paid'
// et inscrit (ou met à jour) l'athlète comme présent + payé sur le créneau.
async function confirmCreneauPayment(session: Stripe.Checkout.Session) {
  const creneauId = session.metadata?.creneau_id;
  const memberId = session.metadata?.member_id;
  if (!creneauId || !memberId) {
    console.warn("Paiement créneau sans métadonnées :", session.id);
    return;
  }

  await supabase.from("creneau_payments")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("stripe_session_id", session.id);

  const { error } = await supabase.from("creneau_attendees").upsert({
    creneau_id: creneauId,
    athlete_id: memberId,            // référence club_members.id
    paid: true,
    stripe_session_id: session.id,
    amount: (session.amount_total ?? 0) / 100,
  }, { onConflict: "creneau_id,athlete_id" });

  if (error) console.error("Upsert attendee payé échoué :", error);
}
