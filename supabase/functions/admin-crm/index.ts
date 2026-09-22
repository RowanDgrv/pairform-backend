// =============================================================================
//  Edge Function : admin-crm (page de maintenance interne, 21/09/2026)
//  ---------------------------------------------------------------------------
//  Fournit à sillance-admin.html (page séparée, jamais liée depuis l'app) une
//  vue agrégée de tous les comptes + quelques actions de maintenance. Chaque
//  action revérifie requireAdmin() elle-même (pas de confiance en un état
//  "déjà vérifié" côté client) : un seul point d'entrée avec dispatch par
//  `action`, service_role pour lire/écrire au-delà de ce que la RLS autorise
//  à un utilisateur normal.
//  Auth : JWT requis (Authorization: Bearer <access_token>) — vérifié par
//  requireAdmin() contre le secret ADMIN_EMAILS (serveur, distinct du
//  ADMIN_EMAILS cosmétique du front). Body JSON : { action, ...params }.
// =============================================================================
import { admin, corsHeaders, json } from "../_shared/providers.ts";
import { requireAdmin } from "../_shared/adminAuth.ts";

async function listUsers(sb: ReturnType<typeof admin>) {
  const { data: profiles, error: pErr } = await sb.from("profiles")
    .select("id, role, full_name, email, created_at, staff")
    .order("created_at", { ascending: false });
  if (pErr) throw pErr;

  const { data: subs, error: sErr } = await sb.from("subscriptions")
    .select("user_id, plan, tier, status, stripe_subscription_id, current_period_end, created_at, updated_at, founder")
    .order("updated_at", { ascending: false });
  if (sErr) throw sErr;
  // une seule ligne par user_id : la plus récente (déjà triée par updated_at desc)
  const subByUser = new Map<string, typeof subs[number]>();
  for (const s of subs ?? []) if (!subByUser.has(s.user_id)) subByUser.set(s.user_id, s);

  const { data: links, error: lErr } = await sb.from("coach_athlete")
    .select("coach_id, athlete_id, status, profiles:athlete_id(id, full_name, email)")
    .eq("status", "active");
  if (lErr) throw lErr;
  const athletesByCoach = new Map<string, { id: string; full_name: string | null; email: string | null }[]>();
  for (const l of links ?? []) {
    const arr = athletesByCoach.get(l.coach_id) ?? [];
    if (l.profiles) arr.push(l.profiles as any);
    athletesByCoach.set(l.coach_id, arr);
  }

  const { data: authUsers, error: aErr } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (aErr) throw aErr;
  const bannedById = new Map<string, boolean>();
  for (const u of authUsers.users) {
    const until = (u as any).banned_until;
    bannedById.set(u.id, !!until && until !== "none" && new Date(until) > new Date());
  }

  const { data: notes, error: nErr } = await sb.from("admin_notes")
    .select("user_id, note, created_at").order("created_at", { ascending: false });
  if (nErr) throw nErr;
  const notesByUser = new Map<string, { note: string; created_at: string }[]>();
  for (const n of notes ?? []) {
    const arr = notesByUser.get(n.user_id) ?? [];
    arr.push({ note: n.note, created_at: n.created_at });
    notesByUser.set(n.user_id, arr);
  }

  // Club géré (clubs.owner_id) : un coach peut cumuler "coach de ses athlètes"
  // ET "gérant d'un club" (cf. sillance-app.core.js, window.__pf_ownsClub) —
  // affiché dans la page admin pour voir/vérifier ce cumul d'un coup d'œil.
  const { data: clubs, error: cErr } = await sb.from("clubs").select("id, name, owner_id");
  if (cErr) throw cErr;
  const clubByOwner = new Map<string, { id: string; name: string }>();
  for (const c of clubs ?? []) clubByOwner.set(c.owner_id, { id: c.id, name: c.name });

  return (profiles ?? []).map((p) => ({
    id: p.id, role: p.role, full_name: p.full_name, email: p.email,
    created_at: p.created_at, staff: p.staff,
    banned: bannedById.get(p.id) ?? false,
    subscription: subByUser.get(p.id) ?? null,
    athletes: athletesByCoach.get(p.id) ?? [],
    athleteCount: (athletesByCoach.get(p.id) ?? []).length,
    notes: notesByUser.get(p.id) ?? [],
    club: clubByOwner.get(p.id) ?? null,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const caller = await requireAdmin(req);
  if (!caller) return json({ error: "Accès refusé" }, 403);

  try {
    const sb = admin();
    const { action, ...p } = await req.json().catch(() => ({ action: null }));

    if (action === "list") {
      return json({ users: await listUsers(sb) });
    }

    // setPlan couvre plan ET palier en un seul appel (la page admin les
    // présente comme un seul choix : "Coach solo · 29€/mois", pas deux
    // contrôles séparés à synchroniser à la main). S'il n'existe encore
    // aucune ligne subscriptions pour ce compte (jamais payé, ou compte de
    // test), on en CRÉE une manuelle (sans stripe_subscription_id) plutôt
    // que d'échouer — c'est le cas normal pour offrir un accès sans passer
    // par Stripe (ex. compte de test, geste commercial).
    if (action === "setPlan") {
      const { userId, plan, tier } = p;
      if (!userId || !plan) return json({ error: "userId et plan requis" }, 400);
      const { data: row } = await sb.from("subscriptions")
        .select("id, stripe_subscription_id").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      let warning: string | null = null;
      if (row) {
        const { error } = await sb.from("subscriptions")
          .update({ plan, tier: tier || null, status: "active", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) throw error;
        warning = row.stripe_subscription_id
          ? "Cet abonnement est relié à un vrai abonnement Stripe : le prochain événement webhook (renouvellement, etc.) écrasera ce changement. Utile pour corriger temporairement, pas pour un changement durable — modifie plutôt l'abonnement dans Stripe."
          : null;
      } else {
        const { error } = await sb.from("subscriptions").insert({
          user_id: userId, plan, tier: tier || null, status: "active",
        });
        if (error) throw error;
        warning = "Abonnement créé manuellement (sans lien Stripe) — n'apparaîtra pas dans le dashboard Stripe. Pour un vrai paiement, l'abonnement doit être créé côté Stripe.";
      }
      return json({ ok: true, warning });
    }

    // Statut "fondateur" (tarif réduit "10 premiers") — indépendant du choix
    // de plan/palier, comme suspend/addNote : un geste ponctuel, pas une
    // conséquence automatique d'un changement de forfait. Nécessite une ligne
    // subscriptions existante (contrairement à setPlan, ne crée rien : on ne
    // marque pas fondateur un compte qui n'a même pas encore de forfait).
    if (action === "setFounder") {
      const { userId, founder } = p;
      if (!userId) return json({ error: "userId requis" }, 400);
      const { data: row } = await sb.from("subscriptions")
        .select("id").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (!row) return json({ error: "Ce compte n'a pas encore de forfait — attribue d'abord un forfait." }, 404);
      const { error } = await sb.from("subscriptions").update({ founder: !!founder }).eq("id", row.id);
      if (error) throw error;
      return json({ ok: true });
    }

    // Donne à un coach la casquette "gérant de club" en plus de son rôle coach
    // (cumul, pas un changement de rôle — cf. window.__pf_ownsClub côté app).
    // Ne fait rien s'il a déjà un club : un coach n'en gère qu'un seul ici.
    if (action === "createClub") {
      const { userId, name } = p;
      if (!userId || !name?.trim()) return json({ error: "userId et name requis" }, 400);
      const { data: existing } = await sb.from("clubs").select("id").eq("owner_id", userId).maybeSingle();
      if (existing) return json({ error: "Ce compte gère déjà un club." }, 409);
      const { data: club, error } = await sb.from("clubs")
        .insert({ name: name.trim(), owner_id: userId }).select("id").single();
      if (error) throw error;
      const { error: oErr } = await sb.from("club_offers").insert([
        { club_id: club.id, tier: "dropin", price: 15, bill_interval: "one_time" },
        { club_id: club.id, tier: "sub", price: 59, bill_interval: "month" },
        { club_id: club.id, tier: "coach", price: 119, bill_interval: "month" },
      ]);
      if (oErr) throw oErr;
      return json({ ok: true, clubId: club.id });
    }

    if (action === "suspend") {
      const { userId, suspend } = p;
      if (!userId) return json({ error: "userId requis" }, 400);
      const { error } = await sb.auth.admin.updateUserById(userId, {
        ban_duration: suspend ? "87600h" : "none", // ~10 ans = suspension de fait ; "none" = lève la suspension
      });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "addNote") {
      const { userId, note } = p;
      if (!userId || !note?.trim()) return json({ error: "userId et note requis" }, 400);
      const { error } = await sb.from("admin_notes").insert({ user_id: userId, note: note.trim(), created_by: caller.id });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "resendEmail") {
      const { userId, type } = p; // 'recovery' | 'invite'
      if (!userId) return json({ error: "userId requis" }, 400);
      const { data: prof, error: pErr } = await sb.from("profiles").select("email").eq("id", userId).single();
      if (pErr || !prof?.email) return json({ error: "Email introuvable pour ce compte" }, 404);
      const { data, error } = await sb.auth.admin.generateLink({
        type: type === "invite" ? "invite" : "recovery",
        email: prof.email,
      });
      if (error) throw error;
      // NB : sans SMTP custom configuré côté Auth, Supabase peut échouer à
      // envoyer l'email lui-même (limite du mailer par défaut) même quand le
      // lien est généré avec succès — on renvoie donc aussi le lien brut pour
      // l'envoyer à la main si besoin (cf. mémoire session : SMTP pas encore posé).
      return json({ ok: true, actionLink: data.properties?.action_link ?? null });
    }

    return json({ error: `Action inconnue : ${action}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur", detail: String(e).slice(0, 200) }, 500);
  }
});
