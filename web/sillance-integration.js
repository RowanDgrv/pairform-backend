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

const A = () => window.__pf_app;   // raccourci vers le hook de l'app
const TRIAL_DAYS = 14;             // durée de l'essai gratuit coach (jours)

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
} : {};
const mapSession = (s) => ({ id: s.id, disc: s.disc, title: esc(s.title), dur: s.dur,
  dist: s.dist, tss: s.tss, zone: s.zone, done: s.done, rpe: s.rpe,
  ...(s.rpe_muscle != null ? { rpeMuscle: s.rpe_muscle } : {}), note: esc(s.note),
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
async function hydrate() {
  const app = A();
  if (!app) { console.warn("[PF] hook __pf_app absent — app pas prête"); return; }
  const uid = PF.user.id;

  // Compte réel = un seul rôle réel : verrouille les 2 autres vues (Coach/
  // Athlète/Club) et bascule sur la sienne. Sans ça, un vrai utilisateur
  // pouvait cliquer librement sur les 3 portes — pensées pour la démo/preview
  // publique, pas pour un compte connecté.
  if (typeof window.__pf_lockModes === "function" && PF.profile?.role) {
    const realMode = PF.profile.role === "club_admin" ? "club" : PF.profile.role;
    window.__pf_lockModes(realMode);
  }

  // Chaque section est isolée : une erreur ne bloque pas les autres.
  await section("refs", async () => {
    const refs = await PF.getAthleteRefs();
    if (refs) app.assignObj(app.data.ATHLETE_REF, mapRefs(refs));
  });

  await section("records", async () => {
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
  });

  await section("checkin", async () => {
    const c = await PF.todayCheckin();
    if (c) app.assignObj(app.data.checkin,
      { sommeil: c.sommeil, fatigue: c.fatigue, motivation: c.motivation,
        // colonnes 0019 (poids/dispo) : absentes tant que la migration n'est pas déployée
        ...(c.poids != null ? { poids: c.poids } : {}),
        ...(c.hrv != null ? { hrv: c.hrv } : {}),
        ...(c.cycle_phase ? { cyclePhase: c.cycle_phase, cycleDay: c.cycle_day } : {}),
        dispo: c.dispo || 'ok', dispoNote: c.dispo_note || '' });
  });

  await section("gear", async () => {
    const items = await PF.getGear(uid);
    // Set inconditionnel : un compte réel sans matériel voit la section vide,
    // pas le matériel de démonstration présenté comme le sien.
    app.setGear?.(items.map(mapGear));
  });

  await section("zones", async () => {
    // zones de travail perso de l'utilisateur (table 0020) — clé = son id.
    try {
      const z = await PF.getAthleteZones(uid);
      app.setAthleteZones?.(uid, z || null);
    } catch (e) { console.warn("[PF] getAthleteZones :", e); }
  });

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
    const list = rows.map((r) => ({
      id: r.athlete_id,
      name: esc(r.profiles?.full_name || r.profiles?.email) || "Athlète",
      checkin: ckByAth[r.athlete_id] || null,
    }));
    // Un coach avec des athlètes liés planifie par défaut pour le premier
    // (plus utile que "pour soi-même" dans le cas d'usage réel).
    if (PF.profile?.role === "coach" && list.length) defaultAthleteId = list[0].id;
    app.setCoachAthletes?.(list, defaultAthleteId);
  });

  await section("planning", async () => {
    await loadPlanningFor(defaultAthleteId);
  });

  await section("videos", async () => {
    const vids = await PF.getVideos();
    if (vids.length) app.replaceArray(app.data.VIDEOS, vids.map(mapVideo));
  });

  await section("club", async () => {
    const clubs = await PF.myClubs();
    if (!clubs.length) {
      // Aucun club réel : ne pas laisser le club de démonstration (Muret Goat
      // Squad et ses adhérents fictifs) visible comme si c'était le sien.
      app.replaceArray(app.data.CLUB_ATHLETES, []);
      app.replaceArray(app.data.CLUB_GROUPS, []);
      app.replaceArray(app.data.CRENEAUX, []);
      const el = document.getElementById("clubName");
      if (el) el.textContent = "Mon club";
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
  });

  // Objets connectés (Strava/Garmin/Coros) : état réel + activités importées.
  await section("devices", async () => { await app.refreshDevices?.(); });

  // Gate premium : masque/déverrouille le contenu payant selon l'abonnement.
  await section("premium", async () => {
    const ok = await PF.isSubscribed();
    document.body.classList.toggle("pf-subscribed", ok);
    window.__pf_subscribed = ok;
    // Essai gratuit + paywall du coach (l'abo 29€ est le produit Phase 1).
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
    const videosOk = role === "athlete" ? await PF.athleteHasVideos() : true;
    window.__pf_videos_ok = videosOk;
    renderVideoGate({ role, videosOk });
  });

  await section("aiAddon", async () => {
    window.__pf_aiAddon = await PF.hasAiAddon();
  });

  // Re-render complet avec les données fraîches.
  try {
    app.renderSidebar?.();
    app.render?.();
    app.updateVideolibVisibility?.();
    if (app.getMode?.() === "club") app.renderClub?.();
  } catch (e) { console.error("[PF] re-render échoué :", e); }

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
    document.body.appendChild(b);
    b.addEventListener("click", () => {
      if (PF.user) { if (confirm("Se déconnecter ?")) PF.signOut().then(() => location.reload()); }
      else openAuth();
    });
  }
  b.classList.toggle("on", !!connected);
  b.textContent = connected ? `☁︎ ${PF.profile?.full_name || "Connecté"}` : "☁︎ Se connecter";
}

let authMode = "signin";
let pickedRole = "athlete";

function openAuth() { injectAuthOverlay(); document.getElementById("pf-auth-overlay").classList.add("open"); }
function closeAuth() { document.getElementById("pf-auth-overlay")?.classList.remove("open"); }

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
    <p class="sub">${isUp ? "Crée ton compte" : "Connecte-toi à ton espace"}</p>
    ${isUp ? `
      <label>Nom complet</label><input id="pf-name" placeholder="Prénom Nom">
      <label>Je suis…</label>
      <div class="row-roles">
        <div class="role" data-role="coach">Coach</div>
        <div class="role" data-role="athlete">Athlète</div>
        <div class="role" data-role="club_admin">Club</div>
      </div>` : ``}
    <label>Email</label><input id="pf-email" type="email" placeholder="toi@mail.com">
    <label>Mot de passe</label><input id="pf-pass" type="password" placeholder="••••••••">
    <div class="err" id="pf-err"></div>
    ${isUp ? `<label class="pf-consent"><input type="checkbox" id="pf-consent"><span>J'accepte que Sillance traite mes données d'entraînement, y compris mes données de santé (check-ins, fréquence cardiaque), pour fournir le service. Voir la <a href="./legal.html#confidentialite" target="_blank" rel="noopener">politique de confidentialité</a>.</span></label>` : ``}
    <button class="primary" id="pf-go">${isUp ? "Créer mon compte" : "Se connecter"}</button>
    <div class="switch">${isUp
      ? `Déjà un compte ? <a id="pf-switch">Se connecter</a>`
      : `Pas encore de compte ? <a id="pf-switch">S'inscrire</a>`}</div>`;

  card.querySelectorAll(".role").forEach((r) => {
    r.classList.toggle("active", r.dataset.role === pickedRole);
    r.onclick = () => { pickedRole = r.dataset.role; renderAuth(); };
  });
  card.querySelector("#pf-switch").onclick = () => { authMode = isUp ? "signin" : "signup"; renderAuth(); };
  card.querySelector("#pf-go").onclick = submitAuth;
}

async function submitAuth() {
  const err = document.getElementById("pf-err");
  err.textContent = "";
  const email = document.getElementById("pf-email").value.trim();
  const password = document.getElementById("pf-pass").value;
  try {
    if (authMode === "signup") {
      const consent = document.getElementById("pf-consent");
      if (consent && !consent.checked) { err.textContent = "Merci d'accepter le traitement de tes données pour créer ton compte."; return; }
      const fullName = document.getElementById("pf-name").value.trim();
      await PF.signUp({ email, password, fullName, role: pickedRole });
      // Selon la config Supabase, une confirmation email peut être requise.
      await PF.signIn({ email, password }).catch(() => {});
      if (!PF.user) { err.textContent = "Compte créé. Vérifie ton email puis connecte-toi."; authMode = "signin"; renderAuth(); return; }
    } else {
      await PF.signIn({ email, password });
    }
    closeAuth();
    await onLoggedIn();
  } catch (e) {
    err.textContent = e?.message || "Erreur de connexion.";
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
    display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
  #pf-lock-overlay .card{max-width:420px;width:92%;background:#0f151b;border:1px solid #223;
    border-radius:16px;padding:30px 28px;text-align:center;box-shadow:0 30px 80px -20px rgba(0,0,0,.7)}
  #pf-lock-overlay h2{font:800 22px/1.15 'Oswald','Archivo',system-ui;color:#eaf6f9;margin:0 0 8px;letter-spacing:.2px}
  #pf-lock-overlay p{font:400 14px/1.5 'Archivo',system-ui;color:#9fb0bb;margin:0 0 20px}
  #pf-lock-overlay .price{font:800 30px 'Oswald',system-ui;color:#46C2D8;margin-bottom:2px}
  #pf-lock-overlay .price small{font:600 13px 'Archivo';color:#7d8d98}
  #pf-lock-overlay .go{width:100%;border:0;background:#46C2D8;color:#06222a;border-radius:11px;
    padding:13px;font:800 15px 'Archivo',system-ui;cursor:pointer;margin-top:16px}
  #pf-lock-overlay .go:hover{filter:brightness(1.06)}
  #pf-lock-overlay .out{display:inline-block;margin-top:14px;color:#7d8d98;font:500 12.5px 'Archivo';
    background:none;border:0;cursor:pointer;text-decoration:underline}
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
    const o = document.createElement("div");
    o.id = "pf-lock-overlay";
    o.innerHTML = `
      <div class="card">
        <h2>Ton essai gratuit est terminé</h2>
        <p>Abonne-toi à Sillance pour continuer à coacher tes athlètes, planifier et analyser.</p>
        <div class="price">29 €<small> /mois</small></div>
        <button class="go" id="pf-lock-go">S'abonner à Sillance</button>
        <button class="out" id="pf-lock-out">Se déconnecter</button>
      </div>`;
    document.body.appendChild(o);
    o.querySelector("#pf-lock-go").onclick = () =>
      PF.startCheckout("coach").catch((e) => console.warn("[PF] checkout:", e));
    o.querySelector("#pf-lock-out").onclick = async () => {
      try { await PF.signOut(); } catch (_) {} location.reload();
    };
    return;
  }

  if (trialDaysLeft != null) {
    const b = document.createElement("div");
    b.id = "pf-trial-banner";
    const j = trialDaysLeft <= 1 ? "dernier jour" : `${trialDaysLeft} jours restants`;
    b.innerHTML = `🎁 Essai gratuit — <b>${j}</b>
      <button id="pf-trial-go">S'abonner (29 €/mois)</button>`;
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
      teaser.innerHTML = `<div class="t">🔒 Vidéos d'exercices réservées</div>
        <div class="s">Ton coach peut débloquer les vidéos de démonstration pour toi.<br>Demande-lui d'activer l'option dans son espace.</div>`;
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
    } else {
      setCloudBadge(false);         // sinon démo intacte + bouton de connexion
    }
  } catch (e) {
    console.warn("[PF] backend indisponible/non configuré → mode démo.", e?.message || e);
    setCloudBadge(false);
  }
})();
