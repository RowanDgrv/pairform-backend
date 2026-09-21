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
    .select("user_id, plan, tier, status, stripe_subscription_id, current_period_end, created_at, updated_at")
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

  return (profiles ?? []).map((p) => ({
    id: p.id, role: p.role, full_name: p.full_name, email: p.email,
    created_at: p.created_at, staff: p.staff,
    banned: bannedById.get(p.id) ?? false,
    subscription: subByUser.get(p.id) ?? null,
    athletes: athletesByCoach.get(p.id) ?? [],
    athleteCount: (athletesByCoach.get(p.id) ?? []).length,
    notes: notesByUser.get(p.id) ?? [],
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

    if (action === "setTier") {
      const { userId, tier } = p;
      if (!userId) return json({ error: "userId requis" }, 400);
      const { data: row } = await sb.from("subscriptions")
        .select("id").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (!row) return json({ error: "Aucun abonnement pour ce compte — pas de ligne à modifier" }, 404);
      const { error } = await sb.from("subscriptions").update({ tier: tier || null, updated_at: new Date().toISOString() }).eq("id", row.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "setPlan") {
      const { userId, plan } = p;
      if (!userId || !plan) return json({ error: "userId et plan requis" }, 400);
      const { data: row } = await sb.from("subscriptions")
        .select("id, stripe_subscription_id").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (!row) return json({ error: "Aucun abonnement pour ce compte — pas de ligne à modifier" }, 404);
      const { error } = await sb.from("subscriptions").update({ plan, updated_at: new Date().toISOString() }).eq("id", row.id);
      if (error) throw error;
      return json({
        ok: true,
        warning: row.stripe_subscription_id
          ? "Cet abonnement est relié à un vrai abonnement Stripe : le prochain événement webhook (renouvellement, etc.) écrasera ce changement de plan. Utile pour corriger temporairement, pas pour un changement durable — modifie plutôt l'abonnement dans Stripe."
          : null,
      });
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
