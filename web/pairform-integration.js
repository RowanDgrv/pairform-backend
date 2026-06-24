/* =============================================================================
 *  PairForm — couche d'intégration (branche l'app HTML sur Supabase)
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
 *   - window.PF        (exposé par pairform-client.js)
 *   - window.__pf_app  (hook exposé par le <script> inline de l'app)
 * ========================================================================== */
import { PF } from "./pairform-client.js";
window.PF = PF;

const A = () => window.__pf_app;   // raccourci vers le hook de l'app

/* -------- petits utilitaires de mapping DB → formes de l'app -------- */
const mapRecord  = (r) => ({ d: r.label, v: r.value, isNew: r.is_new });
const mapVideo   = (v) => ({ id: v.id, disc: v.disc, title: v.title,
  dur: v.duration, level: v.level, desc: v.description, tags: v.tags || [],
  src: v.src || "", premium: !!v.is_premium });
const mapRefs = (p) => p ? {
  ftp: p.ftp, pma: p.pma, cpBike: p.cp_bike, vma: p.vma, cv: p.cv,
  seuilRun: p.seuil_run, css: p.css, fcMax: p.fc_max, fcRepos: p.fc_repos,
} : {};
const mapSession = (s) => ({ id: s.id, disc: s.disc, title: s.title, dur: s.dur,
  dist: s.dist, tss: s.tss, zone: s.zone, done: s.done, rpe: s.rpe,
  blocksV2: s.blocks && s.blocks.length ? { blocks: s.blocks } : undefined });
const mapMember  = (m) => ({ id: m.id, name: m.display_name || "Athlète",
  disc: m.disc || "tri", since: m.since || "", group: m.group_id });
const mapGroup   = (g) => ({ id: g.id, name: g.name, color: g.color, desc: g.description });
const mapCreneau = (c) => ({ id: c.id, disc: c.disc, title: c.title, day: c.day,
  time: c.time, dur: c.dur, place: c.place, cap: c.cap, coach: c.coach,
  price: Number(c.price) || 0, group: c.group_id, attendees: [] });

/* ===========================================================================
 *  HYDRATATION — remplit les globales de l'app depuis Supabase
 * ========================================================================= */
async function hydrate() {
  const app = A();
  if (!app) { console.warn("[PF] hook __pf_app absent — app pas prête"); return; }
  const uid = PF.user.id;

  // Chaque section est isolée : une erreur ne bloque pas les autres.
  await section("refs", async () => {
    const refs = await PF.getAthleteRefs();
    if (refs) app.assignObj(app.data.ATHLETE_REF, mapRefs(refs));
  });

  await section("records", async () => {
    const recs = await PF.getRecords(uid);
    if (recs.length) app.replaceArray(app.data.RECORDS, recs.map(mapRecord));
  });

  await section("checkin", async () => {
    const c = await PF.todayCheckin();
    if (c) app.assignObj(app.data.checkin,
      { sommeil: c.sommeil, fatigue: c.fatigue, motivation: c.motivation });
  });

  await section("planning", async () => {
    // Fenêtre large autour d'aujourd'hui (±4 semaines) pour couvrir la nav.
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 28);
    const to   = new Date(today); to.setDate(to.getDate() + 28);
    const iso = (d) => d.toISOString().slice(0, 10);
    const rows = await PF.getPlanning(uid, iso(from), iso(to));
    app.clearObj(app.data.planning);
    for (const s of rows) {
      (app.data.planning[s.date] ||= []).push(mapSession(s));
    }
  });

  await section("videos", async () => {
    const vids = await PF.getVideos();
    if (vids.length) app.replaceArray(app.data.VIDEOS, vids.map(mapVideo));
  });

  await section("club", async () => {
    const clubs = await PF.myClubs();
    if (!clubs.length) return;
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

/* ===========================================================================
 *  AUTH UI — overlay de connexion / inscription (thème sombre PairForm)
 * ========================================================================= */
function injectStyles() {
  if (document.getElementById("pf-auth-style")) return;
  const css = `
  #pf-cloud-badge{position:fixed;top:10px;right:12px;z-index:9998;font:600 12px/1 system-ui;
    padding:6px 10px;border-radius:99px;background:#161a1f;color:#8a949e;border:1px solid #2a2f37;cursor:pointer}
  #pf-cloud-badge.on{color:#39e6a3;border-color:#235}
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
  .vcard.vlocked .thumb{filter:grayscale(.45) brightness(.62)}
  .vlock{position:absolute;top:8px;right:8px;z-index:3;background:rgba(8,10,13,.72);
    color:#ffd23f;border-radius:99px;padding:3px 8px;font-size:12px;font-weight:700}`;
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
    <h2>PairForm</h2>
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
