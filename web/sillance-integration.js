/* =============================================================================
 *  Sillance — couche d'intégration (branche l'app HTML sur Supabase)
 *
 *  Principe NON DESTRUCTIF :
 *   - Tant qu'aucun utilisateur n'est connecté → on ne touche à RIEN.
 *     L'app reste en mode démo avec ses données en dur. (Sécurité : si ce
 *     fichier bugue, la démo qui marche n'est pas impactée.)
 *   - Dès qu'on se connecte → on hydrate les globales de l'app EN PLACE
 *     (mêmes références d'objets/tableaux que les closures de rendu utilisent)
 *     puis on re-render.
 *
 *  Dépend de :
 *   - window.PF        (exposé par sillance-client.js)
 *   - window.__pf_app  (hook exposé par le <script> inline de l'app)
 * ========================================================================== */
import { PF } from "./sillance-client.js";
window.PF = PF;

function tr(key, vars) { return window.SilI18n ? window.SilI18n.t(key, vars) : key; }

const A = () => window.__pf_app;   // raccourci vers le hook de l'app
const TRIAL_DAYS = 14;             // durée de l'essai gratuit coach (jours)

// -------- anti-bot (audit sécurité 23-24/08/2026, point "protection anti-robots") --------
// Cloudflare Turnstile sur le formulaire de connexion/inscription : gratuit,
// généralement invisible pour un vrai visiteur (pas de puzzle à résoudre).
// TURNSTILE_SITE_KEY = À REMPLACER par la clé de site créée sur le dashboard
// Cloudflare (dash.cloudflare.com → Turnstile → Add site, domaine sillance.app).
// Tant que ce placeholder n'est pas remplacé ET que le "Enable CAPTCHA
// protection" n'est pas activé côté Supabase Auth (Authentication → Settings
// → Bot and Abuse Protection, avec la clé secrète correspondante), ce widget
// ne bloque RIEN : Supabase ignore un captchaToken absent/vide tant que la
// protection n'est pas activée côté serveur. Les deux réglages doivent être
// faits ensemble pour que la protection soit réellement active.
const TURNSTILE_SITE_KEY = "0x0000000000000000000000AA"; // placeholder — à remplacer
let turnstileToken = "";
let turnstileWidgetId = null;
function renderTurnstile() {
  const el = document.getElementById("pf-turnstile");
  if (!el || typeof window.turnstile === "undefined") return;
  if (turnstileWidgetId != null) { try { window.turnstile.remove(turnstileWidgetId); } catch (e) {} }
  turnstileToken = "";
  try {
    turnstileWidgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { turnstileToken = token; },
      "error-callback": () => { turnstileToken = ""; },
      "expired-callback": () => { turnstileToken = ""; },
    });
  } catch (e) { console.warn("[PF] turnstile:", e); }
}

// Comptes modérateurs Sillance : jamais de paywall/essai limité, quel que
// soit le rôle. Volontairement une liste en dur (front only, pas de colonne
// admin en base) — usage interne, à étendre ici si besoin d'un 2e compte.
const ADMIN_EMAILS = ["rowandegraeve@gmail.com"];
const isAdminUser = () => ADMIN_EMAILS.includes((PF.user?.email || "").toLowerCase());

/* -------- mur de connexion (site officiel) --------
   La démo (sillance-app.html sans paramètre) ne change pas : connexion via
   le badge ☁︎, optionnelle, dismissible. Depuis la landing, le bouton
   "Connexion" ajoute ?login=1(&role=coach|club) → l'app ouvre directement
   l'overlay d'auth, IMPOSSIBLE à fermer sans se connecter (pas de démo
   visible derrière). L'inscription "Athlète" en libre-service reste
   volontairement absente de ce mur — un athlète rejoint via le lien
   d'invitation de son coach (?invite=...), pas en s'inscrivant seul. */
const gateParams = new URLSearchParams(location.search);
const gateMode = gateParams.get("login") === "1";
const gateRoleParam = gateParams.get("role"); // 'coach' | 'club'

/* -------- échappement anti-XSS --------
   L'app construit son UI via innerHTML (100+ points) sans échapper. Toute
   donnée LIBRE saisie par un utilisateur (nom d'athlète, titre de séance,
   note, nom de matériel/club/offre…) est donc un vecteur de XSS STOCKÉ :
   un athlète mettant `<img src=x onerror=…>` dans son nom exécuterait du
   code dans la session de SON COACH quand celui-ci ouvre son tableau de bord.
   On neutralise à l'INGESTION : chaque champ texte libre venant de la base
   est échappé ici, une fois, avant d'atteindre le moindre innerHTML. Un nom
   normal (sans <>&"') est inchangé ; seuls les caractères d'injection le sont. */
const esc = (s) => s == null ? s : String(s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/* -------- petits utilitaires de mapping DB → formes de l'app -------- */
const mapRecord  = (r) => ({ d: esc(r.label), v: esc(r.value), isNew: r.is_new });
const mapVideo   = (v) => ({ id: v.id, disc: v.disc, title: esc(v.title),
  dur: v.duration, level: esc(v.level), desc: esc(v.description), tags: (v.tags || []).map(esc),
  src: v.src || "", premium: !!v.is_premium });
const mapRefs = (p) => p ? {
  ftp: p.ftp, pma: p.pma, cpBike: p.cp_bike, vma: p.vma, cv: p.cv,
  seuilRun: p.seuil_run, css: p.css, fcMax: p.fc_max, fcRepos: p.fc_repos,
  updatedAt: p.updated_at,
} : {};
const mapSession = (s) => ({ id: s.id, disc: s.disc, title: esc(s.title), dur: s.dur,
  dist: s.dist, tss: s.tss, zone: s.zone, done: s.done, rpe: s.rpe,
  ...(s.rpe_muscle != null ? { rpeMuscle: s.rpe_muscle } : {}), note: esc(s.note),
  coachNote: esc(s.coach_note),
  blocksV2: s.blocks && s.blocks.length ? { blocks: s.blocks } : undefined });
const mapMember  = (m) => ({ id: m.id, name: esc(m.display_name) || "Athlète",
  disc: m.disc || "tri", since: esc(m.since) || "", group: m.group_id });
const mapGroup   = (g) => ({ id: g.id, name: esc(g.name), color: g.color, desc: esc(g.description) });
const mapCreneau = (c) => ({ id: c.id, disc: c.disc, title: esc(c.title), day: c.day,
  time: c.time, dur: c.dur, place: esc(c.place), cap: c.cap, coach: esc(c.coach),
  price: Number(c.price) || 0, group: c.group_id, attendees: [] });
const mapGear = (g) => ({ id: g.id, type: g.type, name: esc(g.name), brand: esc(g.brand) || "",
  km: Number(g.km) || 0, max: Number(g.max_km) || 1000,
  cat: g.cat || null, price: g.price != null ? Number(g.price) : null,
  notified: g.notified || [] });

/* ===========================================================================
 *  HYDRATATION — remplit les globales de l'app depuis Supabase
 * ========================================================================= */
// État de chargement (audit 03/08/2026 : quasi-absence d'états de chargement
// alors que l'app dépend de nombreux appels async). Barre fine en haut de
// page pendant l'hydratation complète depuis Supabase — la plus grosse
// fenêtre "silencieuse" de l'app (connexion/rechargement).
function showHydrateLoader() {
  let bar = document.getElementById("pf-hydrate-bar");
  if (!bar) {
    if (!document.getElementById("pf-hydrate-style")) {
      const st = document.createElement("style");
      st.id = "pf-hydrate-style";
      st.textContent = "@keyframes pf-hydrate-anim{0%{background-position:200% 0}100%{background-position:-200% 0}}";
      document.head.appendChild(st);
    }
    bar = document.createElement("div");
    bar.id = "pf-hydrate-bar";
    bar.style.cssText = "position:fixed;top:0;left:0;height:3px;width:100%;z-index:9999;"
      + "background:linear-gradient(90deg,transparent,#46C2D8,transparent);background-size:200% 100%;"
      + "animation:pf-hydrate-anim 1.1s ease-in-out infinite;pointer-events:none;";
    document.body.appendChild(bar);
  }
  bar.style.display = "block";
}
function hideHydrateLoader() {
  const bar = document.getElementById("pf-hydrate-bar");
  if (bar) bar.style.display = "none";
}

async function hydrate() {
  const app = A();
  if (!app) { console.warn("[PF] hook __pf_app absent — app pas prête"); return; }
  showHydrateLoader();
  const uid = PF.user.id;

  // Une seule dépendance réelle dans toute l'hydratation : "planning" a besoin
  // de defaultAthleteId, calculé par "coachAthletes". Celle-ci doit donc
  // rester séquentielle et passer avant tout le reste ; les 12 autres sections
  // (+ planning une fois defaultAthleteId connu) sont indépendantes entre elles
  // — chacune isolée par section() — et tournent en parallèle (Promise.all)
  // plutôt qu'en série, ce qui divise le temps d'hydratation par ~1/n plutôt
  // que de le sommer.
  let defaultAthleteId = null; // null = planifier pour soi-même (comportement historique)
  await section("coachAthletes", async () => {
    const rows = await PF.myAthletes();
    // Check-ins du jour du roster : forme + disponibilité (journal blessure)
    // visibles dans le bandeau coach, le sélecteur et la table de suivi.
    let ckByAth = {};
    try {
      const cks = await PF.rosterCheckins(rows.map((r) => r.athlete_id));
      for (const c of cks) ckByAth[c.athlete_id] = {
        sommeil: c.sommeil, fatigue: c.fatigue, motivation: c.motivation,
        dispo: c.dispo || 'ok', dispoNote: c.dispo_note || '',
        ...(c.hrv != null ? { hrv: c.hrv } : {}),
        ...(c.cycle_phase ? { cyclePhase: c.cycle_phase, cycleDay: c.cycle_day } : {}),
      };
    } catch (e) { console.warn("[PF] rosterCheckins :", e); }
    // Fraîcheur des références physio (FTP/VMA/…) du roster : sert le rappel
    // "à retester" dans le bandeau coach, sans exposer les valeurs elles-mêmes.
    let refsByAth = {};
    try {
      const refs = await PF.rosterRefs(rows.map((r) => r.athlete_id));
      for (const r of refs) refsByAth[r.user_id] = r.updated_at;
    } catch (e) { console.warn("[PF] rosterRefs :", e); }
    const list = rows.map((r) => ({
      id: r.athlete_id,
      name: esc(r.profiles?.full_name || r.profiles?.email) || tr("mode.athlete"),
      checkin: ckByAth[r.athlete_id] || null,
      refsUpdatedAt: refsByAth[r.athlete_id] || null,
    }));
    // Un coach avec des athlètes liés planifie par défaut pour le premier
    // (plus utile que "pour soi-même" dans le cas d'usage réel).
    if (PF.profile?.role === "coach" && list.length) defaultAthleteId = list[0].id;
    // Auto-coaching : le coach s'est ajouté à son propre roster (self-coach
    // edge function) — débloque en plus la vue Athlète pour lui (mode.js).
    window.__pf_selfCoached = rows.some((r) => r.athlete_id === uid);
    app.setCoachAthletes?.(list, defaultAthleteId);
  });

  // Compte réel = un seul rôle réel : verrouille les 2 autres vues (Coach/
  // Athlète/Club) et bascule sur la sienne (sauf auto-coaching, ci-dessus,
  // qui débloque aussi Athlète pour un coach). Sans ça, un vrai utilisateur
  // pouvait cliquer librement sur les 3 portes — pensées pour la démo/preview
  // publique, pas pour un compte connecté. Doit tourner APRÈS "coachAthletes"
  // puisque __pf_lockModes lit window.__pf_selfCoached calculé ci-dessus.
  if (typeof window.__pf_lockModes === "function" && PF.profile?.role) {
    const realMode = PF.profile.role === "club_admin" ? "club" : PF.profile.role;
    window.__pf_lockModes(realMode);
  }

  // Les 13 sections restantes sont indépendantes entre elles (chacune isolée
  // par section(), une erreur ne bloque pas les autres) : parallélisées au
  // lieu d'être sommées en série. "planning" peut y rejoindre les autres
  // puisque defaultAthleteId est déjà connu à ce stade.
  await Promise.all([
    section("refs", async () => {
      const refs = await PF.getAthleteRefs();
      if (refs) app.assignObj(app.data.ATHLETE_REF, mapRefs(refs));
    }),

    section("records", async () => {
      const recs = await PF.getRecords(uid);
      if (recs.length) app.replaceArray(app.data.RECORDS, recs.map(mapRecord));
      // Compte confirmé sans la moindre activité réelle (ni record, ni import) :
      // on ne veut pas montrer les records/graphiques de démo comme si c'était
      // les siens. S'il y a le moindre signal réel, on n'y touche pas.
      const acts = await PF.getActivities(1, uid);
      const hasActivity = recs.length > 0 || acts.length > 0;
      if (!hasActivity) {
        app.replaceArray(app.data.RECORDS, []);
        app.setActivityState?.(false);
      }
    }),

    section("checkin", async () => {
      const c = await PF.todayCheckin();
      if (c) app.assignObj(app.data.checkin,
        { sommeil: c.sommeil, fatigue: c.fatigue, motivation: c.motivation,
          // colonnes 0019 (poids/dispo) : absentes tant que la migration n'est pas déployée
          ...(c.poids != null ? { poids: c.poids } : {}),
          ...(c.hrv != null ? { hrv: c.hrv } : {}),
          ...(c.cycle_phase ? { cyclePhase: c.cycle_phase, cycleDay: c.cycle_day } : {}),
          dispo: c.dispo || 'ok', dispoNote: c.dispo_note || '' });
    }),

    section("gear", async () => {
      const items = await PF.getGear(uid);
      // Set inconditionnel : un compte réel sans matériel voit la section vide,
      // pas le matériel de démonstration présenté comme le sien.
      app.setGear?.(items.map(mapGear));
    }),

    section("raceDebriefs", async () => {
      const list = await PF.getRaceDebriefs(uid);
      app.setRaceDebriefs?.(uid, list);
    }),

    section("coTeam", async () => {
      const [team, pending] = await Promise.all([PF.getCoTeam(uid), PF.getPendingCoCoachRequests(uid)]);
      app.setCoTeam?.(uid, team, pending);
    }),

    section("zones", async () => {
      // zones de travail perso de l'utilisateur (table 0020) — clé = son id.
      try {
        const z = await PF.getAthleteZones(uid);
        app.setAthleteZones?.(uid, z || null);
      } catch (e) { console.warn("[PF] getAthleteZones :", e); }
    }),

    section("planning", async () => {
      await loadPlanningFor(defaultAthleteId);
    }),

    section("videos", async () => {
      const vids = await PF.getVideos();
      if (vids.length) app.replaceArray(app.data.VIDEOS, vids.map(mapVideo));
    }),

    section("club", async () => {
      const clubs = await PF.myClubs();
      if (!clubs.length) {
        // Aucun club réel : ne pas laisser le club de démonstration (Muret Goat
        // Squad et ses adhérents fictifs) visible comme si c'était le sien.
        app.replaceArray(app.data.CLUB_ATHLETES, []);
        app.replaceArray(app.data.CLUB_GROUPS, []);
        app.replaceArray(app.data.CRENEAUX, []);
        const el = document.getElementById("clubName");
        if (el) el.textContent = tr("club.myClubFallback");
        return;
      }
      const club = clubs[0];
      window.__pf_clubId = club.id;   // exposé pour les écritures (création créneau)
      const [members, creneaux] = await Promise.all([
        PF.getClubMembers(club.id),
        PF.getCreneaux(club.id),
      ]);
      app.replaceArray(app.data.CLUB_ATHLETES, members.map(mapMember));
      const groups = await PF.sb.from("club_groups").select("*").eq("club_id", club.id);
      if (groups.data) app.replaceArray(app.data.CLUB_GROUPS, groups.data.map(mapGroup));
      app.replaceArray(app.data.CRENEAUX, creneaux.map(mapCreneau));
      // titre du club affiché
      const clubNameEl = document.getElementById("clubName");
      if (clubNameEl) clubNameEl.textContent = club.name;
    }),

    // Objets connectés (Strava/Garmin/Coros) : état réel + activités importées.
    section("devices", async () => { await app.refreshDevices?.(); }),

    // Gate premium : masque/déverrouille le contenu payant selon l'abonnement.
    section("premium", async () => {
      const admin = isAdminUser();
      window.__pf_isAdmin = admin;
      const ok = admin || await PF.isSubscribed();
      document.body.classList.toggle("pf-subscribed", ok);
      window.__pf_subscribed = ok;
      // Essai gratuit + paywall du coach (l'abo 29€ est le produit Phase 1).
      // Compte modérateur : jamais de compte à rebours, jamais bloqué.
      const role = PF.profile?.role;
      let trialDaysLeft = null, locked = false;
      if (role === "coach" && !ok) {
        const created = PF.profile?.created_at ? new Date(PF.profile.created_at) : null;
        if (created && !isNaN(created)) {
          const end = new Date(created.getTime() + TRIAL_DAYS * 86400000);
          trialDaysLeft = Math.ceil((end - Date.now()) / 86400000);
          locked = trialDaysLeft <= 0;
        }
      }
      window.__pf_trial_days = trialDaysLeft;
      renderCoachGate({ subscribed: ok, role, trialDaysLeft, locked });
      // Vidéos : réservées aux athlètes que leur coach a activés (et payés).
      const videosOk = admin || (role === "athlete" ? await PF.athleteHasVideos() : true);
      window.__pf_videos_ok = videosOk;
      renderVideoGate({ role, videosOk });
    }),

    section("aiAddon", async () => {
      window.__pf_aiAddon = isAdminUser() || await PF.hasAiAddon();
    }),
  ]);

  // Re-render complet avec les données fraîches.
  try {
    app.renderSidebar?.();
    app.render?.();
    app.updateVideolibVisibility?.();
    if (app.getMode?.() === "club") app.renderClub?.();
  } catch (e) { console.error("[PF] re-render échoué :", e); }

  hideHydrateLoader();
  setCloudBadge(true);
}

async function section(name, fn) {
  try { await fn(); }
  catch (e) { console.error(`[PF] hydrate ${name} échoué :`, e); }
}

// (Re)charge le planning ET le matériel d'un athlète donné (null = soi-même),
// puis re-render. Utilisé au chargement ET quand le coach change d'athlète.
async function loadPlanningFor(athleteId) {
  const app = A();
  const target = athleteId || PF.user.id;
  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - 28);
  const to   = new Date(today); to.setDate(to.getDate() + 28);
  const iso = (d) => d.toISOString().slice(0, 10);
  const [rows, gearRows, zones] = await Promise.all([
    PF.getPlanning(target, iso(from), iso(to)),
    PF.getGear(target),
    PF.getAthleteZones(target).catch((e) => { console.warn("[PF] getAthleteZones :", e); return null; }),
  ]);
  app.clearObj(app.data.planning);
  for (const s of rows) {
    (app.data.planning[s.date] ||= []).push(mapSession(s));
  }
  // Matériel de CET athlète — vide si rien de renseigné, jamais celui d'un autre.
  app.setGear?.(gearRows.map(mapGear));
  // Zones de travail perso de CET athlète (utilisées par le builder).
  app.setAthleteZones?.(target, zones || null);
  app.render?.();
  app.renderSidebar?.();
}
window.__pf_loadPlanningFor = (athleteId) => {
  loadPlanningFor(athleteId).catch((e) => console.error("[PF] loadPlanningFor échoué :", e));
};

/* ===========================================================================
 *  AUTH UI — overlay de connexion / inscription (thème sombre Sillance)
 * ========================================================================= */
function injectStyles() {
  if (document.getElementById("pf-auth-style")) return;
  const css = `
  #pf-cloud-badge{position:fixed;top:12px;right:14px;z-index:9998;font:700 13px/1 'Archivo',system-ui;
    padding:9px 15px;border-radius:99px;background:#46C2D8;color:#06222a;border:1px solid #46C2D8;cursor:pointer;
    box-shadow:0 6px 18px -6px rgba(70,194,216,.6);transition:filter .15s,transform .15s}
  #pf-cloud-badge:hover{filter:brightness(1.06);transform:translateY(-1px)}
  #pf-cloud-badge.on{background:#12171d;color:#39e6a3;border-color:#274;box-shadow:none;font-weight:600}
  #pf-auth-overlay{position:fixed;inset:0;z-index:9999;background:rgba(8,10,13,.82);
    display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
  #pf-auth-overlay.open{display:flex}
  .pf-auth-card{width:340px;max-width:92vw;background:#11151a;border:1px solid #262c34;border-radius:16px;
    padding:26px 24px;color:#e7edf3;font-family:system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .pf-auth-card h2{margin:0 0 4px;font:700 22px/1.1 'Oswald',system-ui;letter-spacing:.4px;text-transform:uppercase}
  .pf-auth-card p.sub{margin:0 0 18px;color:#8a949e;font-size:13px}
  .pf-auth-card label{display:block;font-size:12px;color:#8a949e;margin:12px 0 5px}
  .pf-auth-card input,.pf-auth-card select{width:100%;box-sizing:border-box;background:#0c0f13;border:1px solid #2a2f37;
    color:#e7edf3;border-radius:9px;padding:10px 11px;font-size:14px}
  .pf-auth-card .row-roles{display:flex;gap:8px;margin-top:6px}
  .pf-auth-card .role{flex:1;text-align:center;padding:9px 0;border:1px solid #2a2f37;border-radius:9px;
    font-size:13px;cursor:pointer;color:#8a949e}
  .pf-auth-card .role.active{border-color:#46C2D8;color:#46C2D8;background:rgba(70,194,216,.08)}
  .pf-auth-card button.primary{width:100%;margin-top:18px;background:#46C2D8;color:#06222a;border:0;
    border-radius:10px;padding:12px;font:700 14px/1 system-ui;cursor:pointer}
  .pf-auth-card .switch{margin-top:14px;text-align:center;font-size:13px;color:#8a949e}
  .pf-auth-card .switch a{color:#46C2D8;cursor:pointer}
  .pf-auth-card .err{color:#ff6b81;font-size:12px;margin-top:10px;min-height:14px}
  .pf-auth-card .pf-consent{display:flex;gap:8px;align-items:flex-start;margin:14px 0 2px;font-size:11.5px;line-height:1.4;color:#9aa3b2}
  .pf-auth-card .pf-consent input{width:auto;margin:2px 0 0;flex-shrink:0}
  .pf-auth-card .pf-consent a{color:#46C2D8}
  .vcard.vlocked .thumb{filter:grayscale(.45) brightness(.62)}
  .vlock{position:absolute;top:8px;right:8px;z-index:3;background:rgba(8,10,13,.72);
    color:#ffd23f;border-radius:99px;padding:3px 8px;font-size:12px;font-weight:700}
  .dev-more{display:flex;gap:8px;margin-top:8px}
  .dev-mini{flex:1;padding:8px 0;border:1px solid #2a2f37;border-radius:9px;background:#0c0f13;
    color:#cfd6de;font-size:12.5px;font-weight:600;cursor:pointer}
  .dev-mini:hover{border-color:#46C2D8;color:#46C2D8}
  .demo-pick{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 4px}
  .dp-lbl{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8a949e;margin-right:2px}
  .dp-chip{padding:5px 10px;border:1px solid #2a2f37;border-radius:99px;background:#0c0f13;
    color:#cfd6de;font-size:12px;font-weight:600;cursor:pointer}
  .dp-chip.on{border-color:#46C2D8;color:#46C2D8;background:rgba(70,194,216,.10)}`;
  const st = document.createElement("style");
  st.id = "pf-auth-style"; st.textContent = css;
  document.head.appendChild(st);
}

function setCloudBadge(connected) {
  let b = document.getElementById("pf-cloud-badge");
  if (!b) {
    b = document.createElement("div");
    b.id = "pf-cloud-badge";
    b.setAttribute("role", "button");
    b.setAttribute("tabindex", "0");
    // Rattaché au <header> plutôt qu'au body (audit a11y 04/08/2026, axe
    // "region" : tout le contenu doit être dans un landmark) — sans impact
    // visuel puisque le badge est en position:fixed (placé par rapport au
    // viewport, pas à son parent DOM).
    (document.querySelector("header") || document.body).appendChild(b);
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); b.click(); }
    });
    b.addEventListener("click", () => {
      if (PF.user) { if (confirm(tr("auth.confirmLogOut"))) PF.signOut().then(() => location.reload()); }
      else openAuth();
    });
  }
  b.classList.toggle("on", !!connected);
  b.textContent = connected ? `☁︎ ${PF.profile?.full_name || tr("auth.connected")}` : `☁︎ ${tr("auth.logIn")}`;
}

let authMode = gateMode ? "signup" : "signin";
let pickedRole = gateMode
  ? (gateRoleParam === "club" ? "club_admin" : "coach")
  : "athlete";
let hardGate = false;

function openAuth(hard = false) {
  hardGate = hard;
  injectAuthOverlay();
  document.getElementById("pf-auth-overlay").classList.add("open");
  if (hard) document.body.style.overflow = "hidden";
}
function closeAuth(force = false) {
  if (hardGate && !force) return;   // mur bloquant : pas de fermeture sans connexion
  document.getElementById("pf-auth-overlay")?.classList.remove("open");
  document.body.style.overflow = "";
}

function injectAuthOverlay() {
  if (document.getElementById("pf-auth-overlay")) { renderAuth(); return; }
  const ov = document.createElement("div");
  ov.id = "pf-auth-overlay";
  ov.innerHTML = `<div class="pf-auth-card"></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeAuth(); });
  renderAuth();
}

function renderAuth() {
  const card = document.querySelector("#pf-auth-overlay .pf-auth-card");
  if (!card) return;
  const isUp = authMode === "signup";
  card.innerHTML = `
    <h2>Sillance</h2>
    <p class="sub">${isUp ? tr("auth.createAccount") : tr("auth.logInToSpace")}</p>
    ${isUp ? `
      <label>${tr("auth.fullName")}</label><input id="pf-name" placeholder="${tr("auth.fullNamePh")}">
      <label>${tr("auth.iAm")}</label>
      <div class="row-roles">
        <div class="role" data-role="coach">${tr("mode.coach")}</div>
        ${hardGate ? `` : `<div class="role" data-role="athlete">${tr("mode.athlete")}</div>`}
        <div class="role" data-role="club_admin">${tr("mode.club")}</div>
      </div>` : ``}
    <label>${tr("common.email")}</label><input id="pf-email" type="email" placeholder="${tr("auth.emailPh")}">
    <label>${tr("auth.password")}</label><input id="pf-pass" type="password" placeholder="••••••••">
    <div class="err" id="pf-err"></div>
    ${isUp ? `<label class="pf-consent"><input type="checkbox" id="pf-consent"><span>${tr("auth.consentText")} <a href="./legal.html#confidentialite" target="_blank" rel="noopener">${tr("auth.privacyPolicyLink")}</a>.</span></label>` : ``}
    <div id="pf-turnstile" style="margin:6px 0"></div>
    <button class="primary" id="pf-go">${isUp ? tr("auth.createMyAccount") : tr("auth.logIn")}</button>
    <div class="switch">${isUp
      ? `${tr("auth.alreadyAccount")} <a id="pf-switch">${tr("auth.logIn")}</a>`
      : `${tr("auth.noAccountYet")} <a id="pf-switch">${tr("auth.signUp")}</a>`}</div>`;

  card.querySelectorAll(".role").forEach((r) => {
    r.classList.toggle("active", r.dataset.role === pickedRole);
    r.onclick = () => { pickedRole = r.dataset.role; renderAuth(); };
  });
  card.querySelector("#pf-switch").onclick = () => { authMode = isUp ? "signin" : "signup"; renderAuth(); };
  card.querySelector("#pf-go").onclick = submitAuth;
  renderTurnstile();
}

// Supabase Auth ne traduit pas ses messages d'erreur (toujours en anglais
// technique, ex. "Invalid login credentials"). Audit produit 23/08/2026,
// point "erreurs de formulaire" : reformule les cas courants dans la langue
// de l'utilisateur ; un message non reconnu (rare, ex. panne réseau
// ponctuelle) reste affiché tel quel plutôt que d'être masqué.
function mapAuthError(e) {
  const msg = String(e?.message || "");
  if (/invalid login credentials/i.test(msg)) return tr("auth.errInvalidCredentials");
  if (/user already registered/i.test(msg)) return tr("auth.errUserExists");
  if (/password.*(least|at least|characters)/i.test(msg)) return tr("auth.errWeakPassword");
  if (/email not confirmed/i.test(msg)) return tr("auth.errEmailNotConfirmed");
  if (/invalid.*email|unable to validate email/i.test(msg)) return tr("auth.errInvalidEmail");
  if (/rate limit|only request this after/i.test(msg)) return tr("auth.errRateLimited");
  return msg || tr("auth.connectionError");
}

async function submitAuth() {
  const err = document.getElementById("pf-err");
  err.textContent = "";
  const email = document.getElementById("pf-email").value.trim();
  const password = document.getElementById("pf-pass").value;
  try {
    if (authMode === "signup") {
      const consent = document.getElementById("pf-consent");
      if (consent && !consent.checked) { err.textContent = tr("auth.pleaseAcceptConsent"); return; }
      const fullName = document.getElementById("pf-name").value.trim();
      await PF.signUp({ email, password, fullName, role: pickedRole, captchaToken: turnstileToken });
      // Selon la config Supabase, une confirmation email peut être requise.
      await PF.signIn({ email, password, captchaToken: turnstileToken }).catch(() => {});
      if (!PF.user) { err.textContent = tr("auth.accountCreatedCheckEmail"); authMode = "signin"; renderAuth(); return; }
    } else {
      await PF.signIn({ email, password, captchaToken: turnstileToken });
    }
    closeAuth(true);
    await onLoggedIn();
  } catch (e) {
    err.textContent = mapAuthError(e);
    renderTurnstile(); // jeton à usage unique : en repréparer un pour la prochaine tentative
  }
}

/* ===========================================================================
 *  PAYWALL COACH — essai gratuit puis blocage (abo Sillance 29€/mois)
 *  - trial actif   → bandeau discret « X jours restants · S'abonner »
 *  - trial terminé → overlay bloquant plein écran (le coach doit s'abonner)
 *  - abonné        → rien
 *  Non destructif : n'agit QUE pour un compte de rôle coach non abonné.
 * ========================================================================= */
function injectGateStyles() {
  if (document.getElementById("pf-gate-style")) return;
  const css = `
  #pf-trial-banner{position:fixed;left:0;right:0;top:0;z-index:9990;
    background:#12313a;color:#d9f5fb;font:600 13px/1.3 'Archivo',system-ui;
    padding:9px 16px;text-align:center;border-bottom:1px solid #1c4a56}
  #pf-trial-banner b{color:#46C2D8}
  #pf-trial-banner button{margin-left:12px;border:1px solid #46C2D8;background:#46C2D8;color:#06222a;
    border-radius:99px;padding:5px 13px;font:700 12px 'Archivo',system-ui;cursor:pointer}
  #pf-trial-banner button:hover{filter:brightness(1.06)}
  #pf-lock-overlay{position:fixed;inset:0;z-index:9995;background:rgba(6,8,11,.9);
    display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);padding:20px}
  #pf-lock-overlay .card{max-width:560px;width:100%;max-height:92vh;overflow-y:auto;background:#0f151b;border:1px solid #223;
    border-radius:16px;padding:30px 28px;text-align:center;box-shadow:0 30px 80px -20px rgba(0,0,0,.7)}
  #pf-lock-overlay h2{font:800 22px/1.15 'Oswald','Archivo',system-ui;color:#eaf6f9;margin:0 0 8px;letter-spacing:.2px}
  #pf-lock-overlay p{font:400 14px/1.5 'Archivo',system-ui;color:#9fb0bb;margin:0 0 20px}
  #pf-lock-overlay .price{font:800 30px 'Oswald',system-ui;color:#46C2D8;margin-bottom:2px}
  #pf-lock-overlay .price small{font:600 13px 'Archivo';color:#7d8d98}
  #pf-lock-overlay .go{width:100%;border:0;background:#46C2D8;color:#06222a;border-radius:11px;
    padding:13px;font:800 15px 'Archivo',system-ui;cursor:pointer;margin-top:16px}
  #pf-lock-overlay .go:hover{filter:brightness(1.06)}
  #pf-lock-overlay .go:disabled{opacity:.5;cursor:not-allowed;filter:none}
  #pf-lock-overlay .out{display:inline-block;margin-top:14px;color:#7d8d98;font:500 12.5px 'Archivo';
    background:none;border:0;cursor:pointer;text-decoration:underline}
  #pf-lock-overlay .tier-lbl{font:700 11px 'Archivo',system-ui;letter-spacing:.09em;text-transform:uppercase;
    color:#7d8d98;text-align:left;margin:22px 0 10px}
  #pf-lock-overlay .tier-picks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  #pf-lock-overlay .tierpick{border:1.5px solid #223;background:#141c24;border-radius:12px;
    padding:14px 8px;cursor:pointer;text-align:center;font-family:'Archivo',system-ui;
    display:flex;flex-direction:column;gap:4px;transition:border-color .12s,background .12s}
  #pf-lock-overlay .tierpick:hover{border-color:#3a5560}
  #pf-lock-overlay .tierpick:disabled{opacity:.55;cursor:wait}
  #pf-lock-overlay .tierpick .tp-price{font:800 19px 'Oswald',system-ui;color:#eaf6f9}
  #pf-lock-overlay .tierpick .tp-price small{font:600 10.5px 'Archivo';color:#7d8d98}
  #pf-lock-overlay .tierpick .tp-cap{font:500 11px/1.3 'Archivo';color:#8ea0aa}
  #pf-lock-overlay .tier-included{list-style:none;margin:16px 0 0;padding:0;text-align:left;
    display:flex;flex-direction:column;gap:7px}
  #pf-lock-overlay .tier-included li{font:400 12.5px/1.4 'Archivo',system-ui;color:#aebcc4;
    display:flex;gap:8px;align-items:baseline}
  #pf-lock-overlay .tier-included li::before{content:"✓";color:#46C2D8;font-weight:700;flex:none}
  #videolib.pf-vlocked > :not(h2):not(#pf-video-teaser){display:none!important}
  #pf-video-teaser{border:1px dashed #2a3b44;border-radius:12px;padding:26px 20px;margin-top:14px;
    text-align:center;background:rgba(70,194,216,.04)}
  #pf-video-teaser .t{font:800 16px 'Oswald',system-ui;color:#eaf6f9;margin-bottom:6px}
  #pf-video-teaser .s{font:400 13.5px/1.5 'Archivo',system-ui;color:#9fb0bb}`;
  const s = document.createElement("style");
  s.id = "pf-gate-style"; s.textContent = css;
  document.head.appendChild(s);
}

function renderCoachGate({ subscribed, role, trialDaysLeft, locked }) {
  injectGateStyles();
  const banner = document.getElementById("pf-trial-banner");
  const overlay = document.getElementById("pf-lock-overlay");
  // Nettoyage : tout retirer par défaut, on ré-affiche selon l'état.
  if (banner) banner.remove();
  if (overlay) overlay.remove();
  document.body.style.paddingTop = "";
  if (subscribed || role !== "coach") return;   // abonné ou pas coach → rien

  if (locked) {
    const TIERS = [
      { n: 1, price: 19, cap: tr("gate.tier1.cap") },
      { n: 2, price: 29, cap: tr("gate.tier2.cap") },
      { n: 3, price: 49, cap: tr("gate.tier3.cap") },
    ];
    const o = document.createElement("div");
    o.id = "pf-lock-overlay";
    o.innerHTML = `
      <div class="card">
        <h2>${tr("gate.trialOverHeading")}</h2>
        <p>${tr("gate.trialOverText2")}</p>
        <div class="tier-lbl">${tr("gate.pickTier")}</div>
        <div class="tier-picks">
          ${TIERS.map((t) => `
            <button class="tierpick" data-tier="${t.n}">
              <span class="tp-price">${t.price}&nbsp;€<small> ${tr("gate.perMonth")}</small></span>
              <span class="tp-cap">${t.cap}</span>
            </button>`).join("")}
        </div>
        <div class="tier-lbl">${tr("gate.includedTitle")}</div>
        <ul class="tier-included">
          <li>${tr("gate.included.f1")}</li>
          <li>${tr("gate.included.f2")}</li>
          <li>${tr("gate.included.f3")}</li>
          <li>${tr("gate.included.f4")}</li>
          <li>${tr("gate.included.f5")}</li>
        </ul>
        <button class="out" id="pf-lock-out">${tr("auth.logOut")}</button>
      </div>`;
    document.body.appendChild(o);
    o.querySelectorAll(".tierpick").forEach((btn) => {
      btn.onclick = () => {
        o.querySelectorAll(".tierpick").forEach((b) => (b.disabled = true));
        btn.querySelector(".tp-price").textContent = tr("gate.selecting");
        PF.startCheckout("coach", Number(btn.dataset.tier)).catch((e) => {
          console.warn("[PF] checkout:", e);
          o.querySelectorAll(".tierpick").forEach((b) => (b.disabled = false));
        });
      };
    });
    o.querySelector("#pf-lock-out").onclick = async () => {
      try { await PF.signOut(); } catch (_) {} location.reload();
    };
    return;
  }

  if (trialDaysLeft != null) {
    const b = document.createElement("div");
    b.id = "pf-trial-banner";
    const j = trialDaysLeft <= 1 ? tr("gate.lastDay") : tr("gate.daysLeft", { n: trialDaysLeft });
    b.innerHTML = `🎁 ${tr("gate.freeTrial")} — <b>${j}</b>
      <button id="pf-trial-go">${tr("gate.subscribePrice")}</button>`;
    document.body.appendChild(b);
    document.body.style.paddingTop = b.offsetHeight + "px";
    b.querySelector("#pf-trial-go").onclick = () =>
      PF.startCheckout("coach").catch((e) => console.warn("[PF] checkout:", e));
  }
}

// Vidéos côté ATHLÈTE : masque la bibliothèque tant que le coach ne l'a pas
// activée pour lui, et affiche un message d'invitation. Coach/club/démo intacts.
function renderVideoGate({ role, videosOk }) {
  injectGateStyles();
  const lib = document.getElementById("videolib");
  if (!lib) return;
  const locked = role === "athlete" && !videosOk;
  lib.classList.toggle("pf-vlocked", locked);
  let teaser = document.getElementById("pf-video-teaser");
  if (locked) {
    if (!teaser) {
      teaser = document.createElement("div");
      teaser.id = "pf-video-teaser";
      teaser.innerHTML = `<div class="t">🔒 ${tr("gate.videosLockedTitle")}</div>
        <div class="s">${tr("gate.videosLockedText1")}<br>${tr("gate.videosLockedText2")}</div>`;
      lib.appendChild(teaser);
    }
  } else if (teaser) {
    teaser.remove();
  }
}

async function onLoggedIn() {
  setCloudBadge(true);
  // Accepte une éventuelle invitation présente dans l'URL (?invite=...).
  const tok = PF.pendingInviteToken?.();
  if (tok) { try { await PF.acceptInvite(tok); } catch (e) { console.warn("[PF] invite:", e); } }
  await hydrate();
  checkPaymentReturn();
}

/* -------- confirmation de paiement (retour Stripe) --------
   Chaque success_url/cancel_url/return_url/refresh_url d'edge function
   pointe vers sillance-app.html avec un paramètre distinct (?checkout=,
   ?ai=, ?coaching=, ?club_sub=, ?videos=, ?creneau=, ?coach_connect=,
   ?club_connect=, ?portal=). Avant ce correctif (audit 23/08/2026), rien ne
   lisait ces paramètres : un client qui venait de payer, ou de relier son
   compte Stripe, atterrissait sur l'app sans la moindre confirmation. */
const PAYMENT_RETURN_PARAMS = {
  checkout: { successValue: "success", cancelValue: "cancel", successKey: "payReturn.checkout.success", cancelKey: "payReturn.checkout.cancel" },
  ai: { successValue: "success", cancelValue: "cancel", successKey: "payReturn.ai.success", cancelKey: "payReturn.ai.cancel" },
  coaching: { successValue: "success", cancelValue: "cancel", successKey: "payReturn.coaching.success", cancelKey: "payReturn.coaching.cancel" },
  club_sub: { successValue: "success", cancelValue: "cancel", successKey: "payReturn.clubSub.success", cancelKey: "payReturn.clubSub.cancel" },
  videos: { successValue: "success", cancelValue: "cancel", successKey: "payReturn.videos.success", cancelKey: "payReturn.videos.cancel" },
  creneau: { successValue: "paid", cancelValue: "cancel", successKey: "payReturn.creneau.success", cancelKey: "payReturn.creneau.cancel" },
  coach_connect: { successValue: "done", cancelValue: "refresh", successKey: "payReturn.coachConnect.success", cancelKey: "payReturn.coachConnect.cancel" },
  club_connect: { successValue: "done", cancelValue: "refresh", successKey: "payReturn.clubConnect.success", cancelKey: "payReturn.clubConnect.cancel" },
};
// Retours sans message dédié (rien de décisif ne s'est produit) : on nettoie
// juste l'URL pour ne pas laisser un ?portal=return disgracieux dans la barre.
const SILENT_RETURN_PARAMS = ["portal"];

function checkPaymentReturn() {
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const [key, cfg] of Object.entries(PAYMENT_RETURN_PARAMS)) {
    const val = params.get(key);
    if (val !== cfg.successValue && val !== cfg.cancelValue) continue;
    const success = val === cfg.successValue;
    showPaymentReturnModal(success, tr(success ? cfg.successKey : cfg.cancelKey));
    params.delete(key);
    changed = true;
    break; // un seul paramètre de retour à la fois en pratique
  }
  for (const key of SILENT_RETURN_PARAMS) {
    if (params.has(key)) { params.delete(key); changed = true; }
  }
  if (changed) {
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
}

function showPaymentReturnModal(success, message) {
  let ov = document.getElementById("pf-payreturn-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "pf-payreturn-overlay";
    ov.className = "overlay";
    ov.style.zIndex = "100000"; // au-dessus du tuto interactif (z-index jusqu'à 99999)
    document.body.appendChild(ov);
  }
  const close = () => ov.classList.remove("open");
  ov.innerHTML = `<div class="modal" style="max-width:420px;text-align:center">
      <button class="close" id="pf-payreturn-close" aria-label="${tr("common.close")}">&times;</button>
      ${success ? '<div style="font-size:38px;color:var(--good);margin-bottom:8px">&#10003;</div>' : ""}
      <h3>${tr(success ? "payReturn.titleSuccess" : "payReturn.titleCancel")}</h3>
      <p style="color:var(--soft);margin:10px 0 20px">${esc(message)}</p>
      <button class="btn" id="pf-payreturn-ok">${tr("payReturn.continue")}</button>
    </div>`;
  ov.classList.add("open");
  ov.querySelector("#pf-payreturn-close").onclick = close;
  ov.querySelector("#pf-payreturn-ok").onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

/* ===========================================================================
 *  BOOT de l'intégration
 * ========================================================================= */
(async function boot() {
  injectStyles();
  // Attend que le hook de l'app soit exposé (le <script> inline tourne avant,
  // mais on sécurise au cas où).
  let tries = 0;
  while (!window.__pf_app && tries < 50) { await new Promise((r) => setTimeout(r, 40)); tries++; }

  // Si Supabase n'est pas encore configuré (placeholder), on ne fait rien :
  // l'app reste en mode démo. Aucune exception ne doit remonter ici.
  try {
    await PF.init();
    if (PF.user) {
      await onLoggedIn();            // session existante → on hydrate
    } else if (gateMode) {
      setCloudBadge(false);
      openAuth(true);                // "Connexion" landing → mur bloquant, pas de démo visible
    } else {
      setCloudBadge(false);         // sinon démo intacte + bouton de connexion
    }
  } catch (e) {
    console.warn("[PF] backend indisponible/non configuré → mode démo.", e?.message || e);
    setCloudBadge(false);
  }
})();
