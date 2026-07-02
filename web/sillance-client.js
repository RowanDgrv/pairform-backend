/* =============================================================================
 *  Sillance — client navigateur (pont vers Supabase)
 *  À inclure dans tes fichiers HTML :
 *
 *    <script type="module">
 *      import { PF } from './sillance-client.js';
 *      window.PF = PF;            // pratique pour tester depuis la console
 *      await PF.init();
 *    </script>
 *
 *  Remplit SUPABASE_URL et SUPABASE_ANON_KEY ci-dessous (dispo dans
 *  Supabase > Project Settings > API). La clé "anon" est PUBLIQUE : c'est
 *  normal, la sécurité repose sur la RLS (jamais la service_role côté front).
 * ========================================================================== */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = "https://onbsgohvqejccowfnrbs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Tiz8pcjnik-Xj85Jvahivw_dfNqf_TT";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const PF = {
  sb,
  user: null,
  profile: null,

  // -------- AUTH --------
  async init() {
    const { data } = await sb.auth.getUser();
    this.user = data.user ?? null;
    if (this.user) await this.loadProfile();
    sb.auth.onAuthStateChange((_e, session) => {
      this.user = session?.user ?? null;
    });
    return this.user;
  },

  async signUp({ email, password, fullName, role = "athlete" }) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: fullName, role } },
    });
    if (error) throw error;
    return data;
  },

  async signIn({ email, password }) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    await this.loadProfile();
    return data;
  },

  async signOut() {
    await sb.auth.signOut();
    this.user = null;
    this.profile = null;
  },

  async loadProfile() {
    const { data } = await sb.from("profiles").select("*").eq("id", this.user.id).single();
    this.profile = data;
    return data;
  },

  // -------- ABONNEMENT (Stripe) --------
  // plan ∈ 'coach' | 'athlete' | 'club'
  async startCheckout(plan) {
    const { url } = await this._invoke("stripe-checkout", { plan });
    window.location.href = url;
  },
  async openBillingPortal() {
    const { url } = await this._invoke("stripe-portal", {});
    window.location.href = url;
  },
  async mySubscription() {
    const { data } = await sb.from("subscriptions")
      .select("*").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    return data;
  },
  async isSubscribed() {
    const sub = await this.mySubscription();
    return !!sub && ["active", "trialing"].includes(sub.status);
  },
  // ---- Add-on « Assistant IA » du coach (option payante séparée) ----
  // Le coach a-t-il l'add-on IA actif ? (lecture directe de la table d'entitlement)
  async hasAiAddon() {
    // plusieurs lignes possibles (historique d'abos) → on prend la plus récente
    const { data } = await sb.from("ai_addons")
      .select("status, current_period_end")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!data) return false;
    const live = ["active", "trialing"].includes(data.status);
    const notExpired = !data.current_period_end || new Date(data.current_period_end) > new Date();
    return live && notExpired;
  },
  // Active l'add-on IA → redirige vers le checkout Stripe (produit Sillance).
  async subscribeAiAddon() {
    const { url } = await this._invoke("ai-addon-subscribe", {});
    window.location.href = url;
  },
  // Génère (ou relit depuis le cache) le résumé IA d'une séance.
  // payload : { session_key, bilan, athlete_id?, discipline?, objective?, force? }
  // Renvoie { verdict, headline, bullets, recos, model, cached } ou {error:'add_on_required'}.
  async summarizeSession(payload) {
    return await this._invoke("session-summary", payload);
  },
  // Démarre l'onboarding Stripe Connect du COACH (pour facturer ses athlètes).
  async connectCoachStripe() {
    const { url } = await this._invoke("coach-connect", {});
    window.location.href = url;
  },
  // Offre(s) de coaching d'un coach (par défaut : le coach connecté).
  async getCoachOffers(coachId = this.user.id) {
    const { data } = await sb.from("coach_offers").select("*").eq("coach_id", coachId);
    return data ?? [];
  },
  // Met à jour l'offre de coaching du coach (idempotent : réutilise l'offre
  // existante si aucun id n'est fourni, pour ne pas créer de doublons).
  async saveCoachOffer({ id, name = "Suivi coaching", price }) {
    if (!id) {
      const { data: existing } = await sb.from("coach_offers")
        .select("id").eq("coach_id", this.user.id).limit(1).maybeSingle();
      if (existing) id = existing.id;
    }
    const row = { coach_id: this.user.id, name, price };
    if (id) row.id = id;
    const { data, error } = await sb.from("coach_offers").upsert(row).select().single();
    if (error) throw error; return data;
  },
  // L'athlète s'abonne au suivi de son coach → redirige Stripe.
  // coachId optionnel : si absent, on résout le coach actif de l'athlète.
  async subscribeToCoach(coachId = null, offerId = null) {
    if (!coachId) {
      const { data } = await sb.from("coach_athlete")
        .select("coach_id").eq("athlete_id", this.user.id).eq("status", "active").limit(1).maybeSingle();
      coachId = data?.coach_id;
      if (!coachId) throw new Error("Aucun coach actif pour cet athlète");
    }
    const body = { coach_id: coachId };
    if (offerId) body.offer_id = offerId;
    const { url } = await this._invoke("coach-subscribe", body);
    window.location.href = url;
  },
  // Abonnements de coaching (coach : les siens ; athlète : les siens — via RLS).
  async getCoachingSubscriptions() {
    const { data } = await sb.from("coaching_subscriptions").select("*");
    return data ?? [];
  },

  // -------- DONNÉES ATHLÈTE --------
  async getAthleteRefs() {
    const { data } = await sb.from("athlete_profiles").select("*").eq("user_id", this.user.id).maybeSingle();
    return data;
  },
  async saveAthleteRefs(refs) {
    const { data, error } = await sb.from("athlete_profiles")
      .upsert({ user_id: this.user.id, ...refs, updated_at: new Date().toISOString() })
      .select().single();
    if (error) throw error; return data;
  },

  async getRecords(athleteId = this.user.id) {
    const { data } = await sb.from("records").select("*").eq("athlete_id", athleteId)
      .order("recorded_at", { ascending: false });
    return data ?? [];
  },
  async addRecord({ label, value, isNew = true }) {
    const { data, error } = await sb.from("records")
      .insert({ athlete_id: this.user.id, label, value, is_new: isNew }).select().single();
    if (error) throw error; return data;
  },

  async todayCheckin() {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await sb.from("checkins").select("*")
      .eq("athlete_id", this.user.id).eq("date", today).maybeSingle();
    return data;
  },
  async saveCheckin({ sommeil, fatigue, motivation, readiness }) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb.from("checkins")
      .upsert({ athlete_id: this.user.id, date: today, sommeil, fatigue, motivation, readiness },
              { onConflict: "athlete_id,date" })
      .select().single();
    if (error) throw error; return data;
  },

  // planning[date] -> séances de l'athlète sur une fenêtre de dates
  async getPlanning(athleteId, fromIso, toIso) {
    const { data } = await sb.from("scheduled_sessions").select("*")
      .eq("athlete_id", athleteId).gte("date", fromIso).lte("date", toIso)
      .order("date");
    return data ?? [];
  },
  async scheduleSession(athleteId, dateIso, s) {
    const { data, error } = await sb.from("scheduled_sessions").insert({
      athlete_id: athleteId, created_by: this.user.id, date: dateIso,
      disc: s.disc, title: s.title, dur: s.dur, dist: s.dist, tss: s.tss,
      zone: s.zone, blocks: s.blocks ?? [], source_session_id: s.id ?? null,
    }).select().single();
    if (error) throw error; return data;
  },
  async markSessionDone(id, { done = true, rpe } = {}) {
    const { data, error } = await sb.from("scheduled_sessions")
      .update({ done, rpe }).eq("id", id).select().single();
    if (error) throw error; return data;
  },
  async deleteScheduled(id) {
    const { error } = await sb.from("scheduled_sessions").delete().eq("id", id);
    if (error) throw error; return true;
  },

  // -------- BIBLIOTHÈQUE DE SÉANCES (coach) --------
  async getTemplates() {
    const { data } = await sb.from("sessions").select("*")
      .eq("owner_id", this.user.id).eq("is_template", true).order("created_at", { ascending: false });
    return data ?? [];
  },
  async saveTemplate(s) {
    const { data, error } = await sb.from("sessions").upsert({
      id: s.id, owner_id: this.user.id, disc: s.disc, title: s.title,
      dur: s.dur, dist: s.dist, tss: s.tss, zone: s.zone,
      active_refs: s.activeRefs ?? [], blocks: s.blocks ?? [], is_template: true,
    }).select().single();
    if (error) throw error; return data;
  },

  // -------- COACH : roster d'athlètes --------
  async myAthletes() {
    const { data } = await sb.from("coach_athlete")
      .select("athlete_id, status, profiles:athlete_id(full_name, email)")
      .eq("coach_id", this.user.id).eq("status", "active");
    return data ?? [];
  },
  async linkAthlete(athleteId) {
    const { data, error } = await sb.from("coach_athlete")
      .insert({ coach_id: this.user.id, athlete_id: athleteId }).select().single();
    if (error) throw error; return data;
  },

  // -------- INVITATIONS coach → athlète --------
  // Coach : génère une invitation, renvoie { invite, inviteUrl } à partager.
  async inviteAthlete(email) {
    return await this._invoke("invite-athlete", { email });
  },
  // Athlète connecté : accepte via le token (?invite=... dans l'URL).
  async acceptInvite(token) {
    return await this._invoke("accept-invite", { token });
  },
  // Lit ?invite= dans l'URL courante (à appeler après connexion).
  pendingInviteToken() {
    return new URLSearchParams(location.search).get("invite");
  },
  async myInvitations() {
    const { data } = await sb.from("invitations").select("*")
      .eq("coach_id", this.user.id).order("created_at", { ascending: false });
    return data ?? [];
  },

  // -------- VIDÉOS (B2C) --------
  async getVideos(disc = null) {
    let q = sb.from("videos").select("*");
    if (disc) q = q.eq("disc", disc);
    const { data } = await q.order("title");
    return data ?? [];
  },
  // URL signée (gated). Lève une erreur 'premium_required' si abo manquant.
  async getVideoUrl(videoId) {
    const { url } = await this._invoke("video-url", { video_id: videoId });
    return url;
  },

  // -------- CLUB --------
  async myClubs() {
    const { data } = await sb.from("clubs").select("*").eq("owner_id", this.user.id);
    return data ?? [];
  },
  async createClub(name) {
    const { data, error } = await sb.from("clubs")
      .insert({ name, owner_id: this.user.id }).select().single();
    if (error) throw error; return data;
  },
  async getClubMembers(clubId) {
    const { data } = await sb.from("club_members").select("*, club_groups(name,color)").eq("club_id", clubId);
    return data ?? [];
  },
  async getCreneaux(clubId) {
    const { data } = await sb.from("creneaux").select("*").eq("club_id", clubId).order("day");
    return data ?? [];
  },
  // -------- CLUB : groupes & affectation des membres --------
  async getGroups(clubId) {
    const { data } = await sb.from("club_groups").select("*").eq("club_id", clubId);
    return data ?? [];
  },
  // Crée (sans id) ou met à jour (avec id) un groupe. Renvoie la ligne (id DB).
  async saveGroup({ id, club_id, name, color, description }) {
    const row = { club_id, name, color, description };
    if (id) row.id = id;
    const { data, error } = await sb.from("club_groups").upsert(row).select().single();
    if (error) throw error; return data;
  },
  async deleteGroup(id) {
    const { error } = await sb.from("club_groups").delete().eq("id", id);
    if (error) throw error; return true;
  },
  // Affecte un membre à un groupe (groupId = null pour le retirer).
  async assignMemberGroup(memberId, groupId) {
    const { data, error } = await sb.from("club_members")
      .update({ group_id: groupId }).eq("id", memberId).select().single();
    if (error) throw error; return data;
  },
  async saveCreneau(c) {
    const { data, error } = await sb.from("creneaux").upsert(c).select().single();
    if (error) throw error; return data;
  },
  // Paiement à la carte d'un créneau tarifé (Hyrox, price > 0) → redirige Stripe.
  // = formule « À la séance » (dropin), paiement one-shot.
  async payCreneau(creneauId, memberId) {
    const { url } = await this._invoke("creneau-checkout", {
      creneau_id: creneauId, member_id: memberId,
    });
    window.location.href = url;
  },

  // -------- CLUB : les 3 formules & encaissement (Stripe) --------
  // Les tarifs des 3 formules (dropin/sub/coach), éditables par le club.
  async getClubOffers(clubId) {
    const { data } = await sb.from("club_offers").select("*").eq("club_id", clubId);
    return data ?? [];
  },
  // Met à jour le tarif d'une formule (gérant du club).
  async saveClubOffer(clubId, tier, price) {
    const { data, error } = await sb.from("club_offers")
      .upsert({ club_id: clubId, tier, price }, { onConflict: "club_id,tier" })
      .select().single();
    if (error) throw error; return data;
  },
  // Abonne un membre à une formule RÉCURRENTE ('sub' | 'coach') → redirige Stripe.
  // ('dropin' = paiement à la séance via payCreneau.)
  async subscribeToClubOffer(clubId, memberId, tier) {
    const { url } = await this._invoke("club-subscribe", {
      club_id: clubId, member_id: memberId, tier,
    });
    window.location.href = url;
  },
  // Adhésions du club (gérant : toutes ; membre : la sienne via RLS).
  async getClubMemberships(clubId) {
    const { data } = await sb.from("club_memberships").select("*").eq("club_id", clubId);
    return data ?? [];
  },
  // Démarre l'onboarding Stripe Connect du club (gérant) → redirige Stripe.
  // Tant que non complété, club-subscribe encaisse côté Sillance (fallback démo).
  async connectClubStripe(clubId) {
    const { url } = await this._invoke("club-connect", { club_id: clubId });
    window.location.href = url;
  },

  // -------- OBJETS CONNECTÉS (Strava / Garmin / Coros) --------
  // Démarre la connexion : pour Strava → redirige vers l'autorisation OAuth.
  // Renvoie { pending, message } si la plateforme n'est pas encore homologuée.
  async connectDevice(provider = "strava") {
    const data = await this._invoke("device-connect", { provider });
    if (data?.url) { window.location.href = data.url; return data; }
    return data; // { pending, message } pour garmin/coros
  },
  // Liste des comptes liés (sans jetons — via la vue `my_devices`).
  async myDevices() {
    const { data } = await sb.from("my_devices").select("*");
    return data ?? [];
  },
  async isDeviceConnected(provider = "strava") {
    const list = await this.myDevices();
    return list.some((d) => d.provider === provider && d.connected);
  },
  // Import manuel des dernières activités. Renvoie { imported }.
  async syncDevice(provider = "strava") {
    return await this._invoke("device-sync", { provider });
  },
  async disconnectDevice(provider = "strava") {
    return await this._invoke("device-disconnect", { provider });
  },
  // Activités importées, normalisées (disc/name/start_time/duration_s/distance_m…).
  async getActivities(limit = 20, athleteId = null) {
    let q = sb.from("external_activities").select("*")
      .order("start_time", { ascending: false }).limit(limit);
    if (athleteId) q = q.eq("user_id", athleteId);
    const { data } = await q;
    return data ?? [];
  },

  // -------- interne --------
  async _invoke(fn, body) {
    const { data, error } = await sb.functions.invoke(fn, { body });
    if (error) throw error;
    return data;
  },
};
