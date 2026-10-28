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
  const { data: clubs, error: cErr } = await sb.from("clubs").select("id, name, owner_id, created_at, trial_days");
  if (cErr) throw cErr;
  const clubByOwner = new Map<string, { id: string; name: string; created_at: string; trial_days: number | null }>();
  for (const c of clubs ?? []) clubByOwner.set(c.owner_id, { id: c.id, name: c.name, created_at: c.created_at, trial_days: c.trial_days });

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

    // Mesure d'audience (0078) : agrégats pour sillance-stats.html.
    if (action === "audience") {
      return json(await audience(sb, Number(p.days) || 30));
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

    // Durée d'essai gratuit personnalisée pour un club (avant paywall club,
    // cf. renderClubGate côté front) — null remet la valeur par défaut
    // (TRIAL_DAYS, 14j aujourd'hui). Geste ponctuel par club, comme founder.
    if (action === "setClubTrialDays") {
      const { clubId, trialDays } = p;
      if (!clubId) return json({ error: "clubId requis" }, 400);
      const days = trialDays == null || trialDays === "" ? null : Number(trialDays);
      if (days != null && (!Number.isFinite(days) || days < 0)) {
        return json({ error: "trialDays doit être un nombre positif ou null" }, 400);
      }
      const { error } = await sb.from("clubs").update({ trial_days: days }).eq("id", clubId);
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
      const { userId, type, preview } = p; // 'recovery' | 'invite' ; preview: bool (admin-crm "voir la vue de ce compte")
      if (!userId) return json({ error: "userId requis" }, 400);
      const { data: prof, error: pErr } = await sb.from("profiles").select("email").eq("id", userId).single();
      if (pErr || !prof?.email) return json({ error: "Email introuvable pour ce compte" }, 404);
      // preview=true : redirige vers l'app avec ?adminPreview=1 — sillance-client.js
      // bascule alors la session Supabase sur sessionStorage (isolée à cet onglet,
      // jamais dans le localStorage partagé) au lieu de remplacer la session admin
      // partout sur le domaine (retour Rowan 14/10/2026 : "pas tout me fermer ici").
      const { data, error } = await sb.auth.admin.generateLink({
        type: type === "invite" ? "invite" : "recovery",
        email: prof.email,
        ...(preview ? { options: { redirectTo: "https://sillance.app/sillance-app.html?adminPreview=1" } } : {}),
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


/* ===================== Mesure d'audience (28/10/2026) =====================
   Agrège pageviews (0078) côté serveur : la page stats ne reçoit que des
   comptes, jamais les lignes. Une « visite » = un visit_id (aléatoire, durée
   de l'onglet). Les lignes d'avant 0078 n'ont pas de visit_id : comptées
   comme une visite par page vue et signalées à part (legacy).            */
type PV = { created_at: string; path: string; referrer_host: string | null; event: string; label: string | null; visit_id: string | null; src: string | null };

function sourceOf(r: PV): string {
  if (r.src) return r.src;
  const h = (r.referrer_host || "").toLowerCase();
  if (!h) return "direct / inconnu";
  if (h.includes("linkedin") || h === "lnkd.in") return "linkedin";
  if (h.includes("instagram")) return "instagram";
  if (h.includes("facebook") || h === "l.facebook.com") return "facebook";
  if (h.includes("google")) return h.includes("android.gm") ? "gmail" : "google";
  if (h.includes("bing") || h.includes("duckduckgo") || h.includes("qwant") || h.includes("ecosia")) return "moteur de recherche";
  if (h.includes("t.co") || h.includes("twitter") || h.includes("x.com")) return "x / twitter";
  return h;
}
const parisDay = (iso: string) => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date(iso));
const isHome = (p: string) => p === "/" || p === "/index.html";

async function audience(sb: ReturnType<typeof admin>, daysIn: number) {
  const days = Math.min(Math.max(Math.round(daysIn), 1), 400);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const rows: PV[] = [];
  for (let off = 0; off < 200000; off += 1000) {
    const { data, error } = await sb.from("pageviews")
      .select("created_at, path, referrer_host, event, label, visit_id, src")
      .gte("created_at", from).order("created_at", { ascending: true }).range(off, off + 999);
    if (error) throw error;
    rows.push(...(data as PV[]));
    if (!data || data.length < 1000) break;
  }

  // visites : regroupement par visit_id ; legacy = 1 visite par page vue
  const visits = new Map<string, PV[]>();
  let legacy = 0;
  rows.forEach((r, i) => {
    const k = r.visit_id ?? `legacy-${i}`;
    if (!r.visit_id) { if (r.event !== "view") return; legacy++; }
    (visits.get(k) ?? visits.set(k, []).get(k)!).push(r);
  });

  const daily = new Map<string, { views: number; visits: Set<string> }>();
  rows.forEach((r, i) => {
    if (r.event !== "view") return;
    const d = parisDay(r.created_at);
    const e = daily.get(d) ?? daily.set(d, { views: 0, visits: new Set() }).get(d)!;
    e.views++; e.visits.add(r.visit_id ?? `legacy-${i}`);
  });

  type Src = { source: string; visits: number; home: number; read50: number; ctaApp: number; app: number; signup: number };
  const bySrc = new Map<string, Src>();
  const funnel = { visits: 0, home: 0, read50: 0, ctaApp: 0, app: 0, signup: 0 };
  const scroll: Record<string, number> = { "25": 0, "50": 0, "75": 0, "100": 0 };
  const clicks = new Map<string, number>();
  const pages = new Map<string, number>();

  for (const [k, list] of visits) {
    const first = list.find((r) => r.event === "view") ?? list[0];
    const tracked = !k.startsWith("legacy-");
    const src = sourceOf(list.find((r) => r.src) ?? first);
    const e = bySrc.get(src) ?? bySrc.set(src, { source: src, visits: 0, home: 0, read50: 0, ctaApp: 0, app: 0, signup: 0 }).get(src)!;
    const home = list.some((r) => r.event === "view" && isHome(r.path));
    const read50 = list.some((r) => r.event === "scroll" && isHome(r.path) && Number(r.label) >= 50);
    const ctaApp = list.some((r) => r.event === "click" && (r.label ?? "").includes("sillance-app"));
    const app = list.some((r) => r.event === "view" && r.path === "/sillance-app.html");
    const signup = list.some((r) => r.event === "signup");
    e.visits++; funnel.visits++;
    if (home) { e.home++; funnel.home++; }
    if (tracked && read50) { e.read50++; funnel.read50++; }
    if (tracked && ctaApp) { e.ctaApp++; funnel.ctaApp++; }
    if (app) { e.app++; funnel.app++; }
    if (signup) { e.signup++; funnel.signup++; }
    const depths = new Set(list.filter((r) => r.event === "scroll" && isHome(r.path)).map((r) => r.label ?? ""));
    depths.forEach((d) => { if (d in scroll) scroll[d]++; });
  }
  rows.forEach((r) => {
    if (r.event === "click" && r.label) { const key = `${r.path} → ${r.label}`; clicks.set(key, (clicks.get(key) ?? 0) + 1); }
    if (r.event === "view") pages.set(r.path, (pages.get(r.path) ?? 0) + 1);
  });

  return {
    days, from,
    totals: { views: rows.filter((r) => r.event === "view").length, visits: visits.size, legacyVisits: legacy, events: rows.length },
    daily: [...daily.entries()].sort().map(([day, v]) => ({ day, views: v.views, visits: v.visits.size })),
    sources: [...bySrc.values()].sort((a, b) => b.visits - a.visits),
    funnel, scroll,
    clicks: [...clicks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([what, n]) => ({ what, n })),
    pages: [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([path, n]) => ({ path, n })),
  };
}
