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

/* -------- fetch résilient (timeout + retry) --------
   Constat de l'audit pré-prod : aucun retry ni timeout sur les appels
   réseau côté client — une requête qui pend bloque indéfiniment, un blip
   réseau fait échouer sans seconde chance. Branché une seule fois via
   l'option `global.fetch` du client Supabase : couvre TOUTES les requêtes
   (table queries, RPC, functions.invoke) sans toucher chaque appel un par
   un. Le timeout s'applique à tout ; le retry est réservé aux lectures
   (GET) — rejouer une écriture (POST/PATCH/DELETE) à l'aveugle risquerait
   un doublon si le premier essai avait en fait réussi côté serveur. */
const FETCH_TIMEOUT_MS = 12000;
const READ_RETRIES = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resilientFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const maxAttempts = method === "GET" ? READ_RETRIES + 1 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(onAbort, FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Erreur serveur transitoire sur une lecture : encore une chance.
      if (method === "GET" && res.status >= 500 && attempt < maxAttempts) {
        await sleep(300 * attempt);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      lastErr = e;
      if (attempt < maxAttempts) { await sleep(300 * attempt); continue; }
      throw e;
    }
  }
  throw lastErr;
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: resilientFetch },
});

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

  async signUp({ email, password, fullName, role = "athlete", captchaToken }) {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: fullName, role }, captchaToken },
    });
    if (error) throw error;
    return data;
  },

  async signIn({ email, password, captchaToken }) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password, options: { captchaToken } });
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
    const { data, error } = await sb.from("profiles").select("*").eq("id", this.user.id).single();
    if (error) console.warn("[PF] lecture profiles échouée :", error.message);
    this.profile = data;
    return data;
  },

  // -------- ABONNEMENT (Stripe) --------
  // plan ∈ 'coach' | 'athlete' | 'club'. tier (coach/club) ∈ 1|2|3 = paliers
  // (cf. stripe-checkout). interval ∈ 'month'|'year' (07/10/2026, mensuel/
  // annuel) — omis = mensuel, comportement inchangé pour les anciens appels.
  async startCheckout(plan, tier, interval) {
    const body = { plan };
    if (tier) body.tier = tier;
    if (interval) body.interval = interval;
    const { url } = await this._invoke("stripe-checkout", body);
    window.location.href = url;
  },
  async openBillingPortal() {
    const { url } = await this._invoke("stripe-portal", {});
    window.location.href = url;
  },
  async mySubscription() {
    const { data, error } = await sb.from("subscriptions")
      .select("*").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) console.warn("[PF] lecture subscriptions échouée :", error.message);
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
    const { data, error } = await sb.from("ai_addons")
      .select("status, current_period_end")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) console.warn("[PF] lecture ai_addons échouée :", error.message);
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
  // ---- Option « Vidéos » PAR ATHLÈTE (le coach paie un siège par athlète) ----
  // Liste des activations vidéo du coach connecté : [{athlete_id, active}].
  async getVideoAccess() {
    const { data, error } = await sb.from("video_access")
      .select("athlete_id, active").eq("coach_id", this.user.id).limit(500);
    if (error) console.warn("[PF] lecture video_access échouée :", error.message);
    return data ?? [];
  },
  // Le coach (dés)active les vidéos pour un athlète. Renvoie {url} si un
  // paiement est requis (1er siège) → on redirige ; sinon {ok, seats}.
  async setAthleteVideos(athleteId, enabled) {
    const res = await this._invoke("video-seats-set", { athlete_id: athleteId, enabled });
    if (res?.url) { window.location.href = res.url; return res; }
    return res;
  },
  // L'athlète connecté a-t-il accès aux vidéos ? (activé par son coach ET payé)
  async athleteHasVideos() {
    const { data, error } = await sb.rpc("athlete_has_videos");
    if (error) { console.warn("athlete_has_videos:", error.message); return false; }
    return !!data;
  },
  // ---- Consentement parental (membre mineur d'un club) -----------------------
  // Enregistre le statut mineur + l'autorisation du représentant légal. Le
  // gestionnaire du club atteste avoir recueilli l'autorisation ; on horodate.
  async setParentalConsent(memberId, { is_minor, guardian_name, guardian_email, consent }) {
    const patch = {
      is_minor: !!is_minor,
      guardian_name: is_minor ? (guardian_name || null) : null,
      guardian_email: is_minor ? (guardian_email || null) : null,
      guardian_consent_at: (is_minor && consent) ? new Date().toISOString() : null,
    };
    const { error } = await sb.from("club_members").update(patch).eq("id", memberId);
    if (error) throw error;
    return patch;
  },
  // ---- Matériel : usure chaussures / vélos (table gear, RLS par athlète) ------
  // Liste le matériel actif (athlète connecté, ou un athlète suivi côté coach).
  async getGear(athleteId = this.user.id) {
    const { data, error } = await sb.from("gear")
      .select("id, type, name, brand, km, max_km, cat, session_types, price, notified, retired")
      .eq("athlete_id", athleteId).eq("retired", false)
      .order("created_at", { ascending: true });
    if (error) { console.warn("getGear:", error.message); return []; }
    return data ?? [];
  },
  // Ajoute un équipement. g = { type, name, brand?, km?, max_km?, cat?, sessionTypes?, price?, notified? }.
  // cat : catégorie catalogue (daily/tempo/race/trail, chaussures uniquement, repli legacy).
  // sessionTypes : usages d'entraînement à choix multiple (easy/interval/tempo/race,
  // migration 0053) — préféré par recommendShoe() quand renseigné.
  async addGear(g) {
    const { data, error } = await sb.from("gear")
      .insert({ athlete_id: this.user.id, type: g.type, name: g.name,
                brand: g.brand ?? null, km: g.km ?? 0, max_km: g.max_km ?? 1000,
                cat: g.cat ?? null, session_types: g.sessionTypes?.length ? g.sessionTypes : null,
                price: g.price ?? null, notified: g.notified ?? [] })
      .select().single();
    if (error) { console.warn("addGear:", error.message); return null; }
    return data;
  },
  // Met à jour un équipement (km, notified, retired…). patch = { km?, notified?, … }.
  async updateGear(id, patch) {
    const { error } = await sb.from("gear").update(patch)
      .eq("id", id).eq("athlete_id", this.user.id);
    if (error) console.warn("updateGear:", error.message);
    return !error;
  },
  // Archivage doux d'un équipement (retired=true : garde l'historique d'usure).
  async retireGear(id) {
    return await this.updateGear(id, { retired: true });
  },
  // Jour deadline du coach pour la planification hebdo (rappel H-72/48/24).
  async getWeekDeadlineDay() {
    const { data, error } = await sb.from("profiles").select("week_deadline_day").eq("id", this.user.id).single();
    if (error) { console.warn("getWeekDeadlineDay:", error.message); return null; }
    return data?.week_deadline_day ?? null;
  },
  async setWeekDeadlineDay(day) {
    const { error } = await sb.from("profiles").update({ week_deadline_day: day }).eq("id", this.user.id);
    if (error) throw error;
    return true;
  },
  // Prévient l'athlète que sa semaine (week_monday = date ISO du lundi) est prête.
  async notifyWeekReady(athleteId, weekMonday) {
    return await this._invoke("notify-week-ready", { athlete_id: athleteId, week_monday: weekMonday });
  },
  // Démarre l'onboarding Stripe Connect du COACH (pour facturer ses athlètes).
  async connectCoachStripe() {
    const { url } = await this._invoke("coach-connect", {});
    window.location.href = url;
  },
  // Offre(s) de coaching d'un coach (par défaut : le coach connecté).
  async getCoachOffers(coachId = this.user.id) {
    const { data, error } = await sb.from("coach_offers").select("*").eq("coach_id", coachId);
    if (error) console.warn("[PF] lecture coach_offers échouée :", error.message);
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
      const { data, error } = await sb.from("coach_athlete")
        .select("coach_id").eq("athlete_id", this.user.id).eq("status", "active").limit(1).maybeSingle();
    if (error) console.warn("[PF] lecture coach_athlete échouée :", error.message);
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
    const { data, error } = await sb.from("coaching_subscriptions").select("*");
    if (error) console.warn("[PF] lecture coaching_subscriptions échouée :", error.message);
    return data ?? [];
  },
  // Factures Stripe des athlètes qui paient CE coach (montant, athlète, PDF).
  async getCoachInvoices() {
    return await this._invoke("coach-invoices", {});
  },

  // -------- DONNÉES ATHLÈTE --------
  async getAthleteRefs() {
    const { data, error } = await sb.from("athlete_profiles").select("*").eq("user_id", this.user.id).maybeSingle();
    if (error) console.warn("[PF] lecture athlete_profiles échouée :", error.message);
    return data;
  },
  async saveAthleteRefs(refs) {
    const { data, error } = await sb.from("athlete_profiles")
      .upsert({ user_id: this.user.id, ...refs, updated_at: new Date().toISOString() })
      .select().single();
    if (error) throw error; return data;
  },

  // -------- ZONES DE TRAVAIL PERSONNALISÉES (coach définit, athlète lit) --------
  // zones = { modelKey: [[nom, borneBasse, borneHaute], ...] } (migration 0020)
  async getAthleteZones(athleteId = this.user.id) {
    const { data, error } = await sb.from("athlete_zones").select("zones")
      .eq("athlete_id", athleteId).maybeSingle();
    if (error) console.warn("[PF] lecture athlete_zones échouée :", error.message);
    return data ? data.zones : null;
  },
  async saveAthleteZones(athleteId, zones) {
    const { error } = await sb.from("athlete_zones")
      .upsert({ athlete_id: athleteId || this.user.id, zones: zones || {},
                updated_by: this.user.id, updated_at: new Date().toISOString() },
              { onConflict: "athlete_id" });
    if (error) throw error;
  },

  async getRecords(athleteId = this.user.id) {
    const { data, error } = await sb.from("records").select("*").eq("athlete_id", athleteId)
      .order("recorded_at", { ascending: false }).limit(200);
    if (error) console.warn("[PF] lecture records échouée :", error.message);
    return data ?? [];
  },
  async addRecord({ label, value, isNew = true }) {
    const { data, error } = await sb.from("records")
      .insert({ athlete_id: this.user.id, label, value, is_new: isNew }).select().single();
    if (error) throw error; return data;
  },

  async todayCheckin() {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb.from("checkins").select("*")
      .eq("athlete_id", this.user.id).eq("date", today).maybeSingle();
    if (error) console.warn("[PF] lecture checkins échouée :", error.message);
    return data;
  },
  async saveCheckin({ sommeil, fatigue, motivation, readiness, poids, dispo, dispoNote, hrv, cyclePhase, cycleDay }) {
    const today = new Date().toISOString().slice(0, 10);
    const base = { athlete_id: this.user.id, date: today, sommeil, fatigue, motivation, readiness };
    // dispo/poids (0019) + hrv (0022) + cycle (0023) : si pas encore déployées,
    // on retombe sur le payload historique plutôt que d'échouer.
    const full = { ...base, poids: poids ?? null, dispo: dispo ?? null, dispo_note: dispoNote ?? null, hrv: hrv ?? null,
                   cycle_phase: cyclePhase ?? null, cycle_day: cycleDay ?? null };
    let { data, error } = await sb.from("checkins")
      .upsert(full, { onConflict: "athlete_id,date" }).select().single();
    if (error) {
      ({ data, error } = await sb.from("checkins")
        .upsert(base, { onConflict: "athlete_id,date" }).select().single());
    }
    if (error) throw error; return data;
  },
  // Check-ins du jour de plusieurs athlètes (roster coach — RLS "coach reads").
  async rosterCheckins(athleteIds) {
    if (!athleteIds?.length) return [];
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb.from("checkins").select("*")
      .in("athlete_id", athleteIds).eq("date", today);
    if (error) console.warn("[PF] lecture checkins échouée :", error.message);
    return data ?? [];
  },
  // Fraîcheur des références physio du roster (pas les valeurs, juste la date).
  async rosterRefs(athleteIds) {
    if (!athleteIds?.length) return [];
    const { data, error } = await sb.from("athlete_profiles").select("user_id, updated_at")
      .in("user_id", athleteIds);
    if (error) console.warn("[PF] lecture athlete_profiles échouée :", error.message);
    return data ?? [];
  },
  // ---- Notification du matin (récap séances + matériel) ----
  // Préférences : heure d'envoi, fuseau, canal (email | push | both | none).
  async getNotifPrefs() {
    const { data, error } = await sb.from("notification_prefs")
      .select("send_hour, send_minute, tz, channel").maybeSingle();
    if (error) console.warn("[PF] lecture notification_prefs échouée :", error.message);
    return data;
  },
  async saveNotifPrefs({ hour, minute, tz, channel }) {
    const { error } = await sb.from("notification_prefs")
      .upsert({ user_id: this.user.id, send_hour: hour, send_minute: minute ?? 0,
                tz: tz || "Europe/Paris", channel, updated_at: new Date().toISOString() },
              { onConflict: "user_id" });
    if (error) throw error; return true;
  },
  // Abonnement Web Push du navigateur courant (un par appareil).
  async savePushSubscription(subJson) {
    const { error } = await sb.from("push_subscriptions")
      .upsert({ user_id: this.user.id, endpoint: subJson.endpoint,
                p256dh: subJson.keys?.p256dh, auth: subJson.keys?.auth,
                ua: navigator.userAgent.slice(0, 200) },
              { onConflict: "endpoint" });
    if (error) throw error; return true;
  },
  async removePushSubscription(endpoint) {
    await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
  },

  // planning[date] -> séances de l'athlète sur une fenêtre de dates
  async getPlanning(athleteId, fromIso, toIso) {
    const { data, error } = await sb.from("scheduled_sessions").select("*")
      .eq("athlete_id", athleteId).gte("date", fromIso).lte("date", toIso)
      .order("date");
    if (error) console.warn("[PF] lecture scheduled_sessions échouée :", error.message);
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
  // Variante "upsert" pour une séance matérialisée depuis un créneau (0059) :
  // delete-puis-insert sur (athlete_id, source_creneau_id, date) pour que
  // ré-enregistrer le contenu du créneau, ou qu'un athlète rejoigne/quitte/
  // rejoigne, remplace la séance au lieu d'empiler des doublons.
  async scheduleSessionFromCreneau(athleteId, dateIso, s, creneauId) {
    await sb.from("scheduled_sessions").delete()
      .eq("athlete_id", athleteId).eq("source_creneau_id", creneauId).eq("date", dateIso);
    const { data, error } = await sb.from("scheduled_sessions").insert({
      athlete_id: athleteId, created_by: this.user.id, date: dateIso,
      disc: s.disc, title: s.title, dur: s.dur, dist: s.dist, tss: s.tss,
      zone: s.zone, blocks: s.blocks ?? [], source_creneau_id: creneauId,
    }).select().single();
    if (error) throw error; return data;
  },
  // Retire la séance matérialisée d'un créneau quitté (désinscription).
  async unscheduleFromCreneau(athleteId, creneauId, dateIso) {
    const { error } = await sb.from("scheduled_sessions").delete()
      .eq("athlete_id", athleteId).eq("source_creneau_id", creneauId).eq("date", dateIso);
    if (error) throw error; return true;
  },
  async updateScheduled(id, s) {
    const { data, error } = await sb.from("scheduled_sessions").update({
      disc: s.disc, title: s.title, dur: s.dur, dist: s.dist, tss: s.tss,
      zone: s.zone, blocks: s.blocks ?? [],
    }).eq("id", id).select().single();
    if (error) throw error; return data;
  },
  async markSessionDone(id, { done = true, rpe, rpeMuscle } = {}) {
    const payload = { done, rpe };
    // rpe_muscle : colonne 0021 — repli gracieux si pas encore déployée.
    const full = { ...payload, rpe_muscle: rpeMuscle ?? null };
    let { data, error } = await sb.from("scheduled_sessions").update(full).eq("id", id).select().single();
    if (error) {
      ({ data, error } = await sb.from("scheduled_sessions").update(payload).eq("id", id).select().single());
    }
    if (error) throw error; return data;
  },
  async deleteScheduled(id) {
    const { error } = await sb.from("scheduled_sessions").delete().eq("id", id);
    if (error) throw error; return true;
  },
  // Note du coach sur une séance précise (traçabilité d'un ajustement), visible
  // par l'athlète. RLS : couverte par "sched: coach manages athlete plan".
  async setCoachNote(id, note) {
    const { error } = await sb.from("scheduled_sessions").update({ coach_note: note }).eq("id", id);
    if (error) throw error; return true;
  },

  // -------- FEEDBACK HEBDO BIDIRECTIONNEL --------
  async getWeekPulse(athleteId, weekMonday) {
    const { data, error } = await sb.from("week_pulses").select("*")
      .eq("athlete_id", athleteId).eq("week_monday", weekMonday).maybeSingle();
    if (error) console.warn("[PF] lecture week_pulses échouée :", error.message);
    return data;
  },
  async saveMyWeekFeel(weekMonday, feel, note) {
    const { error } = await sb.from("week_pulses")
      .upsert({ athlete_id: this.user.id, week_monday: weekMonday, athlete_feel: feel, athlete_note: note },
        { onConflict: "athlete_id,week_monday" });
    if (error) throw error; return true;
  },
  async saveCoachWeekNote(athleteId, weekMonday, note) {
    const { error } = await sb.from("week_pulses")
      .upsert({ athlete_id: athleteId, week_monday: weekMonday, coach_note: note },
        { onConflict: "athlete_id,week_monday" });
    if (error) throw error; return true;
  },

  // -------- DÉBRIEF POST-COURSE (journal de course de l'athlète) --------
  async getRaceDebriefs(athleteId = this.user.id) {
    const { data, error } = await sb.from("race_debriefs").select("*")
      .eq("athlete_id", athleteId).order("race_date", { ascending: false });
    if (error) console.warn("[PF] lecture race_debriefs échouée :", error.message);
    return (data ?? []).map((d) => ({ race: d.race_name, date: d.race_date, result: d.result,
      felt: d.felt, nutrition: d.nutrition, weather: d.weather, good: d.good, bad: d.bad }));
  },
  async saveRaceDebrief({ raceName, raceDate, result, felt, nutrition, weather, good, bad }) {
    const { data, error } = await sb.from("race_debriefs")
      .upsert({ athlete_id: this.user.id, race_name: raceName, race_date: raceDate,
        result, felt, nutrition, weather, good, bad }, { onConflict: "athlete_id,race_name,race_date" })
      .select().single();
    if (error) throw error; return data;
  },

  // -------- CALENDRIER DE SAISON + FICHE DE COURSE (table races, migration 0049) --------
  // athleteId par défaut = soi-même (vue Athlète) ; le coach passe l'id de
  // l'athlète depuis la fiche athlète — la RLS (is_coach_of) fait la garde,
  // pas de filtre athlete_id côté client sur update/delete (le coach doit
  // pouvoir écrire sur des lignes qui ne sont pas les siennes).
  async getRaces(athleteId = this.user.id) {
    const { data, error } = await sb.from("races")
      .select("id, name, location, race_date, type, priority, result, recap")
      .eq("athlete_id", athleteId).order("race_date", { ascending: true });
    if (error) { console.warn("[PF] getRaces:", error.message); return []; }
    return data ?? [];
  },
  // r = { athleteId, name, location?, raceDate ('AAAA-MM-JJ'), type?, priority? }.
  async addRace(r) {
    const { data, error } = await sb.from("races")
      .insert({ athlete_id: r.athleteId, name: r.name, location: r.location ?? null,
                race_date: r.raceDate, type: r.type ?? "run", priority: r.priority ?? "C" })
      .select().single();
    if (error) { console.warn("[PF] addRace:", error.message); return null; }
    return data;
  },
  // patch = { name?, location?, race_date?, type?, priority?, result?, recap? }.
  async updateRace(id, patch) {
    const { error } = await sb.from("races")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) console.warn("[PF] updateRace:", error.message);
    return !error;
  },
  async deleteRace(id) {
    const { error } = await sb.from("races").delete().eq("id", id);
    if (error) console.warn("[PF] deleteRace:", error.message);
    return !error;
  },

  // -------- BIBLIOTHÈQUE DE SÉANCES (coach) --------
  async getTemplates() {
    const { data, error } = await sb.from("sessions").select("*")
      .eq("owner_id", this.user.id).eq("is_template", true).order("created_at", { ascending: false });
    if (error) console.warn("[PF] lecture sessions échouée :", error.message);
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

  // -------- BIBLIOTHÈQUE OFFICIELLE SILLANCE (incluse dans l'add-on IA) --------
  // 100 séances-types course & vélo. La RLS (my_library_access = has_ai_addon)
  // ne renvoie de lignes QUE si le compte a l'add-on (coach, club, ou staff).
  async getLibrarySessions() {
    const { data, error } = await sb.from("library_sessions").select("*")
      .eq("published", true).order("sort");
    if (error) { console.warn("[PF] library_sessions :", error.message); return []; }
    return data ?? [];
  },
  // Bool explicite (pour l'upsell) — ne révèle que le statut de l'appelant.
  async myLibraryAccess() {
    const { data, error } = await sb.rpc("my_library_access");
    if (error) { console.warn("[PF] my_library_access :", error.message); return false; }
    return data === true;
  },
  // Checkout « Sillance Premium Club » (propriétaire du club) → redirige.
  async subscribeClubPremium(clubId) {
    const { url } = await this._invoke("club-premium-subscribe", { club_id: clubId });
    if (url) window.location.href = url;
  },

  // -------- COACH : roster d'athlètes --------
  async myAthletes() {
    const { data, error } = await sb.from("coach_athlete")
      .select("athlete_id, status, profiles:athlete_id(full_name, email)")
      .eq("coach_id", this.user.id).eq("status", "active");
    if (error) console.warn("[PF] lecture coach_athlete échouée :", error.message);
    const rows = data ?? [];
    // Groupe d'entraînement (club_groups) : un coach qui gère aussi un club
    // peut avoir rangé certains de ses athlètes suivis dans un groupe — sans
    // ça, openAssign() (assigner une séance/un cycle à tout un groupe) ne
    // proposait jamais aucun groupe pour un vrai compte, alors que la
    // fonctionnalité existe déjà côté UI (audit 23/09/2026).
    if (rows.length) {
      const { data: members, error: mErr } = await sb.from("club_members")
        .select("athlete_id, group_id, clubs!inner(owner_id)")
        .eq("clubs.owner_id", this.user.id)
        .not("athlete_id", "is", null);
      if (mErr) console.warn("[PF] lecture club_members (groupes) échouée :", mErr.message);
      const groupByAthlete = new Map((members ?? []).map((m) => [m.athlete_id, m.group_id]));
      for (const r of rows) r.group_id = groupByAthlete.get(r.athlete_id) ?? null;
    }
    return rows;
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
  // -------- INVITATIONS À REJOINDRE UN CLUB (distinct du coaching perso) --------
  // Gérant du club : invite un nouveau membre par email (contact@sillance.app).
  async inviteClubMember(clubId, email) {
    return await this._invoke("invite-club-member", { club_id: clubId, email });
  },
  // Athlète connecté : rejoint le club via le token (?club_invite=... dans l'URL).
  async acceptClubInvite(token) {
    return await this._invoke("accept-club-invite", { token });
  },
  pendingClubInviteToken() {
    return new URLSearchParams(location.search).get("club_invite");
  },
  // ?join=<token> : lien stable du club (widget "Adhérents"), distinct de
  // ?club_invite= (à usage unique, par email).
  pendingJoinToken() {
    return new URLSearchParams(location.search).get("join");
  },
  // Coach : se rattache lui-même comme son propre athlète (self-coaching),
  // compte dans son propre quota d'athlètes (palier de prix).
  async enableSelfCoaching() {
    return await this._invoke("self-coach", {});
  },
  // -------- MODE SPECTATEUR (lien public, sans compte) --------
  // Crée ou réutilise le lien pour cette course précise (idempotent par
  // athlète+course+date). Écriture directe : pas d'usurpation possible,
  // contrairement à coach_athlete (voir migration 0032).
  async getOrCreateSpectatorLink(athleteId, raceName, raceDate, pacingNotes) {
    const { data, error } = await sb.from("spectator_links")
      .upsert({ athlete_id: athleteId, race_name: raceName, race_date: raceDate,
        pacing_notes: pacingNotes || null, created_by: this.user.id },
        { onConflict: "athlete_id,race_name,race_date" })
      .select().single();
    if (error) throw error; return data;
  },

  // -------- CO-COACHING : plusieurs coachs par athlète --------
  // Équipe complète d'un athlète (tous les coachs actifs + leur étiquette de rôle).
  async getCoTeam(athleteId) {
    const { data, error } = await sb.from("coach_athlete")
      .select("id, coach_id, role_label, status, coach:coach_id(full_name, email)")
      .eq("athlete_id", athleteId).eq("status", "active");
    if (error) console.warn("[PF] lecture coach_athlete échouée :", error.message);
    return data ?? [];
  },
  // Demandes d'ajout en attente pour cet athlète (visibles par l'athlète et ses coachs).
  async getPendingCoCoachRequests(athleteId) {
    const { data, error } = await sb.from("co_coach_requests")
      .select("*").eq("athlete_id", athleteId).eq("status", "pending").order("created_at", { ascending: false });
    if (error) console.warn("[PF] lecture co_coach_requests échouée :", error.message);
    return data ?? [];
  },
  // Un coach existant OU l'athlète propose l'ajout d'un coach (par email + rôle libre).
  async requestCoCoach(athleteId, coachEmail, roleLabel) {
    return await this._invoke("co-coach-request", { athleteId, coachEmail, roleLabel });
  },
  // "L'autre partie" valide ou refuse une demande.
  async approveCoCoach(requestId, decision) {
    return await this._invoke("co-coach-approve", { requestId, decision });
  },

  // Lit ?invite= dans l'URL courante (à appeler après connexion).
  pendingInviteToken() {
    return new URLSearchParams(location.search).get("invite");
  },
  async myInvitations() {
    const { data, error } = await sb.from("invitations").select("*")
      .eq("coach_id", this.user.id).order("created_at", { ascending: false });
    if (error) console.warn("[PF] lecture invitations échouée :", error.message);
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
  // Clubs dont je suis propriétaire OU staff (club_members.role coach/admin,
  // multi-coachs 0054) — avant ce fix, un coach staff ne voyait JAMAIS le
  // club du tout dans l'app (myClubs ne testait que la propriété), même
  // avec la RLS club_coach_manages déjà posée côté planning (0058).
  async myClubs() {
    const [owned, staffRows] = await Promise.all([
      sb.from("clubs").select("*").eq("owner_id", this.user.id),
      sb.from("club_members").select("club_id, role, clubs(*)")
        .eq("athlete_id", this.user.id).in("role", ["coach", "admin"]),
    ]);
    if (owned.error) console.warn("[PF] lecture clubs échouée :", owned.error.message);
    if (staffRows.error) console.warn("[PF] lecture club_members (staff) échouée :", staffRows.error.message);
    const byId = new Map();
    (owned.data ?? []).forEach((c) => byId.set(c.id, c));
    (staffRows.data ?? []).forEach((r) => { if (r.clubs && !byId.has(r.club_id)) byId.set(r.club_id, r.clubs); });
    return [...byId.values()];
  },
  async createClub(name) {
    const { data, error } = await sb.from("clubs")
      .insert({ name, owner_id: this.user.id }).select().single();
    if (error) throw error; return data;
  },

  // -------- LIEN D'INVITATION DU CLUB (stable, partagé une fois à tous les
  // athlètes) + demandes d'adhésion reçues via ce lien --------
  // Lecture publique minimale (nom du club) par token, pour la page
  // d'atterrissage — fonctionne même déconnecté (RPC security definer).
  async getClubByJoinToken(token) {
    const { data, error } = await sb.rpc("club_by_join_token", { p_token: token });
    if (error) { console.warn("[PF] club_by_join_token :", error.message); return null; }
    return data?.[0] ?? null;
  },
  // Athlète connecté : envoie une demande d'adhésion pour ce club.
  async requestToJoinClub(clubId, disc, message) {
    const { data, error } = await sb.from("club_join_requests")
      .upsert(
        { club_id: clubId, athlete_id: this.user.id, disc: disc || null, message: message || null, status: "pending" },
        { onConflict: "club_id,athlete_id" },
      ).select().single();
    if (error) throw error; return data;
  },
  // Gérant du club : liste ses demandes en attente (avec le profil du demandeur).
  async myClubJoinRequests(clubId) {
    const { data, error } = await sb.from("club_join_requests")
      .select("id, athlete_id, disc, message, created_at, profiles:athlete_id(full_name, email)")
      .eq("club_id", clubId).eq("status", "pending").order("created_at");
    if (error) { console.warn("[PF] lecture club_join_requests échouée :", error.message); return []; }
    return data ?? [];
  },
  // Gérant du club : accepte (crée le membre, affecté au groupe choisi) ou refuse.
  async resolveJoinRequest(requestId, { accept, clubId, athleteId, groupId }) {
    if (accept) {
      const { error: memErr } = await sb.from("club_members")
        .insert({ club_id: clubId, athlete_id: athleteId, group_id: groupId || null, role: "member" });
      if (memErr) throw memErr;
    }
    const { error } = await sb.from("club_join_requests")
      .update({ status: accept ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
      .eq("id", requestId);
    if (error) throw error;
  },
  async getClubMembers(clubId) {
    // profiles(full_name,email) : un membre rejoint via accept-club-invite n'a
    // pas toujours de display_name posé (fix 0057/accept-club-invite côté
    // écriture) — on retombe sur le nom réel du profil lié pour les membres
    // déjà en base avant ce fix. Nécessite la policy RLS "profiles: club
    // owner reads members" (0057), sinon ce join renvoie null en silence.
    const { data, error } = await sb.from("club_members")
      .select("*, club_groups(name,color), profiles(full_name,email)")
      .eq("club_id", clubId).limit(1000);
    if (error) console.warn("[PF] lecture club_members échouée :", error.message);
    return data ?? [];
  },
  async getCreneaux(clubId) {
    const { data, error } = await sb.from("creneaux").select("*").eq("club_id", clubId).order("day");
    if (error) console.warn("[PF] lecture creneaux échouée :", error.message);
    return data ?? [];
  },
  // Présences de TOUS les créneaux du club en un appel (jointure via creneaux
  // pour filtrer par club_id, creneau_attendees n'a pas cette colonne).
  async getClubAttendance(clubId) {
    const { data, error } = await sb.from("creneau_attendees")
      .select("creneau_id, athlete_id, creneaux!inner(club_id)")
      .eq("creneaux.club_id", clubId);
    if (error) console.warn("[PF] lecture creneau_attendees échouée :", error.message);
    return data ?? [];
  },
  // Séances individuelles (coach → un seul athlète, hors créneau) de tous
  // les adhérents du club sur une fenêtre — calendrier club (0059+), pour
  // distinguer visuellement club/groupe/individuel. RLS : couverte par
  // club_coach_manages (0058), un seul appel plutôt qu'un par adhérent.
  async getClubIndividualSchedule(athleteUids, fromIso, toIso) {
    if (!athleteUids.length) return [];
    const { data, error } = await sb.from("scheduled_sessions")
      .select("id, athlete_id, date, title, dur")
      .in("athlete_id", athleteUids).is("source_creneau_id", null)
      .gte("date", fromIso).lte("date", toIso);
    if (error) { console.warn("[PF] getClubIndividualSchedule :", error.message); return []; }
    return data ?? [];
  },
  // Pointage manuel par le gérant du club (RLS : "attendees: club owner all"
  // — le membre lui-même n'a pas encore de policy d'écriture ici, cf. audit
  // 22/09/2026 : le pointage n'était jusque-là jamais persisté, CRENEAUX
  // arrivait toujours avec attendees:[] côté hydrate).
  async setPresence(creneauId, memberId, present) {
    if (present) {
      const { error } = await sb.from("creneau_attendees")
        .upsert({ creneau_id: creneauId, athlete_id: memberId }, { onConflict: "creneau_id,athlete_id" });
      if (error) throw error;
    } else {
      const { error } = await sb.from("creneau_attendees")
        .delete().eq("creneau_id", creneauId).eq("athlete_id", memberId);
      if (error) throw error;
    }
    return true;
  },
  // -------- CLUB : groupes & affectation des membres --------
  async getGroups(clubId) {
    const { data, error } = await sb.from("club_groups").select("*").eq("club_id", clubId);
    if (error) console.warn("[PF] lecture club_groups échouée :", error.message);
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
  // Auto-inscription/désinscription d'un adhérent à un créneau (RLS 0058 :
  // "attendees: member self manages own", scopée à SA propre ligne
  // club_members — avant ce fix le bouton "s'inscrire" ne touchait qu'un
  // tableau JS local, jamais la base, pour tout compte réel).
  async joinCreneau(creneauId, memberId) {
    const { error } = await sb.from("creneau_attendees")
      .upsert({ creneau_id: creneauId, athlete_id: memberId }, { onConflict: "creneau_id,athlete_id" });
    if (error) throw error; return true;
  },
  async leaveCreneau(creneauId, memberId) {
    const { error } = await sb.from("creneau_attendees")
      .delete().eq("creneau_id", creneauId).eq("athlete_id", memberId);
    if (error) throw error; return true;
  },
  // Séance-type attachée à un créneau (0058) : posée une fois par le coach
  // (bouton "Créer une séance pour ce créneau"), copiée sur le calendrier de
  // chaque athlète qui s'inscrit ensuite (scheduleSessionFromCreneau).
  async setCreneauSessionTemplate(creneauId, template) {
    const { error } = await sb.from("creneaux")
      .update({ session_template: template }).eq("id", creneauId);
    if (error) throw error; return true;
  },
  // -------- CLUB : compétitions (objectifs par groupe) --------
  async getClubCompetitions(clubId) {
    const { data, error } = await sb.from("club_competitions").select("*").eq("club_id", clubId).order("date");
    if (error) console.warn("[PF] lecture club_competitions échouée :", error.message);
    return data ?? [];
  },
  async saveClubCompetition({ id, club_id, name, date, level, target_group_id }) {
    const row = { club_id, name, date, level, target_group_id };
    if (id) row.id = id;
    const { data, error } = await sb.from("club_competitions").upsert(row).select().single();
    if (error) throw error; return data;
  },
  async getClubCompetitionResponses(competitionIds) {
    if (!competitionIds.length) return [];
    const { data, error } = await sb.from("club_competition_responses")
      .select("*").in("competition_id", competitionIds);
    if (error) console.warn("[PF] lecture club_competition_responses échouée :", error.message);
    return data ?? [];
  },
  // L'athlète répond pour lui-même (RLS : athlete_id = auth.uid()).
  async respondToClubCompetition(competitionId, status) {
    const { error } = await sb.from("club_competition_responses")
      .upsert({ competition_id: competitionId, athlete_id: this.user.id, status },
        { onConflict: "competition_id,athlete_id" });
    if (error) throw error; return true;
  },

  // -------- CLUB : les 3 formules & encaissement (Stripe) --------
  // Les tarifs des 3 formules (dropin/sub/coach), éditables par le club.
  async getClubOffers(clubId) {
    const { data, error } = await sb.from("club_offers").select("*").eq("club_id", clubId);
    if (error) console.warn("[PF] lecture club_offers échouée :", error.message);
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
    const { data, error } = await sb.from("club_memberships").select("*").eq("club_id", clubId);
    if (error) console.warn("[PF] lecture club_memberships échouée :", error.message);
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
    const { data, error } = await sb.from("my_devices").select("*");
    if (error) console.warn("[PF] lecture my_devices échouée :", error.message);
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
  // Pousse une séance planifiée vers la montre connectée de l'athlète (pour
  // l'instant : COROS seulement — Polar/Garmin n'ont pas d'écriture self-
  // service côté API). scheduledSessionId = l'id retourné par scheduleSession.
  // Lève si la discipline n'est pas poussable (natation/renfo/hyrox) — le
  // message d'erreur invite alors à proposer l'export .FIT.
  async pushSessionToWatch(scheduledSessionId, dateIso) {
    return await this._invoke("push-session-to-watch", { scheduled_session_id: scheduledSessionId, date: dateIso });
  },
  // Activités importées, normalisées (disc/name/start_time/duration_s/distance_m…).
  async getActivities(limit = 20, athleteId = null) {
    // duplicate_of : exclut les doublons multi-plateformes déjà résolus
    // (0062) — la même séance importée par Strava ET par la montre ne doit
    // apparaître qu'une fois (la marque de la montre gagne).
    let q = sb.from("external_activities").select("*")
      .is("duplicate_of", null)
      .order("start_time", { ascending: false }).limit(limit);
    if (athleteId) q = q.eq("user_id", athleteId);
    const { data } = await q;
    return data ?? [];
  },
  // Ressenti (RPE 1-10 effort + sensation 1-5 bien-être, distincts façon
  // Nolio/iDO + note libre) + matériel utilisé pour une activité synchronisée
  // — flux bloquant à la connexion (cf. sillance-integration.js
  // queueFeelingPrompts). patch = { rpe, mood?, note?, gearId? }.
  async logActivityFeeling(activityId, patch) {
    const { error } = await sb.from("external_activities").update({
      rpe: patch.rpe, feeling_mood: patch.mood ?? null,
      feeling_note: patch.note ?? null, gear_id: patch.gearId ?? null,
      feeling_logged_at: new Date().toISOString(),
    }).eq("id", activityId).eq("user_id", this.user.id);
    if (error) console.warn("logActivityFeeling:", error.message);
    return !error;
  },
  // Détail seconde-par-seconde d'une activité Strava (GPS/FC/allure/puissance),
  // récupéré à la demande et mis en cache côté serveur. Renvoie la même forme
  // que window.PFFit (points bruts) pour rejouer le modal d'analyse.
  // { points, laps } — laps = vrais laps de la montre au format {start,end}
  // (indices dans points), [] si l'activité n'en a aucun (découpage auto au
  // km côté front dans ce cas).
  async getActivityStreams(activityId) {
    const data = await this._invoke("strava-activity-streams", { activity_id: activityId });
    return { points: data?.points ?? [], laps: data?.laps ?? [] };
  },
  // Persiste un import manuel .TCX/.GPX (window.PFFit.parseFile → { summary, data }).
  // Upsert sur (provider, provider_activity_id) : ré-importer le même fichier ne duplique pas.
  async saveActivity(summary, data) {
    const avgPowerPts = (data?.pts || []).filter((p) => p.pw > 0).map((p) => p.pw);
    const avgPower = avgPowerPts.length
      ? Math.round(avgPowerPts.reduce((a, b) => a + b, 0) / avgPowerPts.length)
      : null;
    const startTime = summary.date ? new Date(summary.date) : new Date();
    const row = {
      user_id: this.user.id,
      provider: "upload",
      provider_activity_id: `${summary.source}-${startTime.getTime()}-${Math.round((summary.dist || 0) * 1000)}`,
      disc: summary.disc,
      name: summary.title,
      start_time: startTime.toISOString(),
      duration_s: Math.round((summary.durMin || 0) * 60),
      distance_m: Math.round((summary.dist || 0) * 1000),
      elevation_m: summary.dplus ?? null,
      avg_hr: summary.avgHr || null,
      max_hr: summary.maxHr || null,
      avg_power: avgPower,
      avg_speed: summary.avgSpeed ?? null,
      raw: data ?? null,
    };
    const { data: saved, error } = await sb.from("external_activities")
      .upsert(row, { onConflict: "provider,provider_activity_id" })
      .select().single();
    if (error) { console.warn("saveActivity:", error.message); return null; }
    return saved;
  },

  // -------- télémétrie --------
  // Best-effort : ne doit jamais faire planter l'appelant ni remonter d'erreur.
  async logClientError({ message, stack, url, context }) {
    try {
      await sb.from("client_errors").insert({
        user_id: this.user?.id ?? null,
        message: String(message ?? "").slice(0, 2000),
        stack: stack ? String(stack).slice(0, 8000) : null,
        url: url ? String(url).slice(0, 500) : null,
        user_agent: navigator.userAgent.slice(0, 300),
        context: context ?? null,
      });
    } catch { /* silencieux — la télémétrie ne doit jamais casser l'app */ }
  },

  // -------- interne --------
  async _invoke(fn, body) {
    const { data, error } = await sb.functions.invoke(fn, { body });
    if (error) throw error;
    return data;
  },
};
