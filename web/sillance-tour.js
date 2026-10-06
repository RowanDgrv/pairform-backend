/* Sillance — tuto interactif "guidé" (spotlight + flèche), création de séance.
   Moteur DOM pur (sélecteurs CSS + événements réels), aucune dépendance sur
   les variables internes de l'app — l'utilisateur clique vraiment, une vraie
   séance est créée à la fin.
   Usage : <script src="./sillance-tour.js"></script> puis SillanceTour.init()
   après le premier render(). Le bouton #tutoBtn (topbar) appelle start(). */
(function(global){
  'use strict';

  function tr(key, vars){ return global.SilI18n ? global.SilI18n.t(key, vars) : key; }

  /* TOURS : registre de tous les tutos guidés — chacun {steps, doneKey,
     modeBtnId}. `doneKey` = clé localStorage marquant le tuto comme vu ;
     `modeBtnId` = id du bouton de mode qui doit être actif pour que le tuto
     reste affiché (sinon abandon propre, cf. isModeActive). */
  var TOURS = {
    session: {
      doneKey: 'sil_tour_done',
      modeBtnId: 'modeCoach',
      steps: [
        { id:'welcome', target:null, get title(){return tr('tour.welcome.title')},
          get text(){return tr('tour.welcome.text')},
          get cta(){return tr('tour.welcome.cta')} },
        { id:'create', target:'#createSessionBtn', get title(){return tr('tour.create.title')},
          get text(){return tr('tour.create.text')}, wait:'click' },
        { id:'sport', target:'#bDiscPick', get title(){return tr('tour.sport.title')},
          get text(){return tr('tour.sport.text')}, wait:'change',
          accept:function(el){ return el.value==='run'; } },
        { id:'warmup', target:'#bBlocks .bk:first-child .bk-lines .ln', get title(){return tr('tour.warmup.title')},
          get text(){return tr('tour.warmup.text')},
          get cta(){return tr('tour.warmup.cta')} },
        { id:'addexo', target:'#bBlocks .bk:nth-child(2) [data-add="exo"]', get title(){return tr('tour.addexo.title')},
          get text(){return tr('tour.addexo.text')}, wait:'click' },
        { id:'intensity', target:'#bBlocks .bk:nth-child(2) .bk-lines .ln:last-child .ln-zonesel', get title(){return tr('tour.intensity.title')},
          get text(){return tr('tour.intensity.text')}, wait:'change' },
        { id:'recov', target:'#bBlocks .bk:nth-child(2) [data-add="recov"]', get title(){return tr('tour.recov.title')},
          get text(){return tr('tour.recov.text')}, wait:'click' },
        { id:'series', target:'#bBlocks .bk:nth-child(2) [data-f="series"]', get title(){return tr('tour.series.title')},
          get text(){return tr('tour.series.text')}, wait:'input' },
        { id:'save', target:'#bSaveCal', get title(){return tr('tour.save.title')},
          get text(){return tr('tour.save.text')}, wait:'click' }
      ]
    },
    groupes: {
      doneKey: 'sil_tour_done_groupes',
      modeBtnId: 'modeClub',
      steps: [
        { id:'welcome', target:null, get title(){return tr('tour.groupes.welcome.title')},
          get text(){return tr('tour.groupes.welcome.text')},
          get cta(){return tr('tour.groupes.welcome.cta')} },
        { id:'open', target:'#clubAddGroup', get title(){return tr('tour.groupes.open.title')},
          get text(){return tr('tour.groupes.open.text')}, wait:'click' },
        { id:'name', target:'#grpName', get title(){return tr('tour.groupes.name.title')},
          get text(){return tr('tour.groupes.name.text')}, wait:'input' },
        { id:'color', target:'#grpColors', get title(){return tr('tour.groupes.color.title')},
          get text(){return tr('tour.groupes.color.text')}, wait:'click' },
        { id:'members', target:'#grpMembers', get title(){return tr('tour.groupes.members.title')},
          get text(){return tr('tour.groupes.members.text')}, wait:'click' },
        { id:'save', target:'#grpSave', get title(){return tr('tour.groupes.save.title')},
          get text(){return tr('tour.groupes.save.text')}, wait:'click' }
      ]
    },
    suivi: {
      doneKey: 'sil_tour_done_suivi',
      modeBtnId: 'modeClub',
      steps: [
        { id:'welcome', target:null, get title(){return tr('tour.suivi.welcome.title')},
          get text(){return tr('tour.suivi.welcome.text')},
          get cta(){return tr('tour.suivi.welcome.cta')} },
        { id:'open', target:'.suivi-card:first-child [data-suivi-add]', get title(){return tr('tour.suivi.open.title')},
          get text(){return tr('tour.suivi.open.text')}, wait:'click' },
        { id:'disc', target:'#ttDisc', get title(){return tr('tour.suivi.disc.title')},
          get text(){return tr('tour.suivi.disc.text')}, wait:'change' },
        { id:'event', target:'#ttEvent', get title(){return tr('tour.suivi.event.title')},
          get text(){return tr('tour.suivi.event.text')}, wait:'change' },
        { id:'time', target:'#ttTime', get title(){return tr('tour.suivi.time.title')},
          get text(){return tr('tour.suivi.time.text')}, wait:'input' },
        { id:'save', target:'#ttSave', get title(){return tr('tour.suivi.save.title')},
          get text(){return tr('tour.suivi.save.text')}, wait:'click' }
      ]
    },
    competitions: {
      doneKey: 'sil_tour_done_competitions',
      modeBtnId: 'modeClub',
      steps: [
        { id:'welcome', target:null, get title(){return tr('tour.competitions.welcome.title')},
          get text(){return tr('tour.competitions.welcome.text')},
          get cta(){return tr('tour.competitions.welcome.cta')} },
        { id:'open', target:'#clubAddCompetition', get title(){return tr('tour.competitions.open.title')},
          get text(){return tr('tour.competitions.open.text')}, wait:'click' },
        { id:'name', target:'#cpName', get title(){return tr('tour.competitions.name.title')},
          get text(){return tr('tour.competitions.name.text')}, wait:'input' },
        { id:'date', target:'#cpDate', get title(){return tr('tour.competitions.date.title')},
          get text(){return tr('tour.competitions.date.text')}, wait:'change' },
        { id:'level', target:'#cpLevel', get title(){return tr('tour.competitions.level.title')},
          get text(){return tr('tour.competitions.level.text')}, wait:'change' },
        { id:'group', target:'#cpGroup', get title(){return tr('tour.competitions.group.title')},
          get text(){return tr('tour.competitions.group.text')}, wait:'change' },
        { id:'save', target:'#cpSave', get title(){return tr('tour.competitions.save.title')},
          get text(){return tr('tour.competitions.save.text')}, wait:'click' },
        { id:'respond', target:'[data-comp-confirm]', get title(){return tr('tour.competitions.respond.title')},
          get text(){return tr('tour.competitions.respond.text')},
          get cta(){return tr('tour.competitions.respond.cta')} }
      ]
    }
  };

  var active = false;
  var currentTourId = null;
  var currentIndex = -1;
  var currentStep = null;
  var rafId = null;
  var veilEl, spotEl, calloutEl;

  function currentTour(){ return TOURS[currentTourId]; }
  function currentSteps(){ var t = currentTour(); return t ? t.steps : []; }

  function qs(sel){ return sel ? document.querySelector(sel) : null; }

  function injectStyles(){
    if(document.getElementById('sil-tour-style')) return;
    var css = ''
      + '#sil-tour-veil{position:fixed;inset:0;background:rgba(4,6,11,.72);z-index:99997;opacity:0;transition:opacity .25s ease;pointer-events:none}'
      + '#sil-tour-veil.show{opacity:1;pointer-events:auto}'
      + '#sil-tour-spot{position:fixed;z-index:99998;pointer-events:none;border-radius:12px;box-shadow:0 0 0 9999px rgba(4,6,11,.72);border:2px solid var(--accent,#46C2D8);opacity:0;transition:left .28s cubic-bezier(.4,0,.2,1),top .28s cubic-bezier(.4,0,.2,1),width .28s cubic-bezier(.4,0,.2,1),height .28s cubic-bezier(.4,0,.2,1),opacity .2s ease}'
      + '#sil-tour-spot.show{opacity:1}'
      + '#sil-tour-spot::after{content:"";position:absolute;inset:-6px;border-radius:16px;border:2px solid var(--accent,#46C2D8);opacity:.55;animation:silTourPulse 1.6s ease-out infinite}'
      + '@keyframes silTourPulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.14);opacity:0}}'
      + '.sil-tour-callout{position:fixed;z-index:99999;width:290px;max-width:calc(100vw - 28px);background:var(--panel-2,#141C2D);border:1px solid var(--line-strong,rgba(150,165,200,.24));border-radius:14px;box-shadow:0 24px 60px -20px rgba(0,0,0,.7);padding:16px 16px 14px;font-family:var(--font-ui,\'Archivo\',sans-serif);color:var(--text,#EAEEF7);opacity:0;transform:translateY(4px);transition:opacity .22s ease,transform .22s ease,left .28s cubic-bezier(.4,0,.2,1),top .28s cubic-bezier(.4,0,.2,1)}'
      + '.sil-tour-callout.show{opacity:1;transform:translateY(0)}'
      + '.sil-tour-callout::before{content:"";position:absolute;width:13px;height:13px;background:var(--panel-2,#141C2D);border:1px solid var(--line-strong,rgba(150,165,200,.24));transform:rotate(45deg)}'
      + '.sil-tour-callout.side-bottom::before{top:-7px;left:50%;margin-left:-7px;border-right:none;border-bottom:none}'
      + '.sil-tour-callout.side-top::before{bottom:-7px;left:50%;margin-left:-7px;border-left:none;border-top:none}'
      + '.sil-tour-callout.side-right::before{left:-7px;top:50%;margin-top:-7px;border-top:none;border-right:none}'
      + '.sil-tour-callout.side-left::before{right:-7px;top:50%;margin-top:-7px;border-bottom:none;border-left:none}'
      + '.sil-tour-callout.side-center::before{display:none}'
      + '.stc-step{font-family:var(--font-data,\'JetBrains Mono\',monospace);font-size:10.5px;letter-spacing:.06em;color:var(--muted,#8B95AD);text-transform:uppercase;margin:0 0 6px}'
      + '.stc-title{font-family:var(--font-display,\'Oswald\',sans-serif);font-size:16px;font-weight:600;letter-spacing:.01em;margin:0 0 6px}'
      + '.stc-text{font-size:13px;line-height:1.45;color:var(--soft,#C2CAD9);margin:0 0 12px}'
      + '.stc-hint{font-size:12px;color:var(--accent,#46C2D8);font-weight:600;display:flex;align-items:center;gap:6px;margin:0 0 4px}'
      + '.stc-hint .chev{display:inline-block;animation:silChevBounce 1s ease-in-out infinite}'
      + '@keyframes silChevBounce{0%,100%{transform:translateX(0)}50%{transform:translateX(4px)}}'
      + '.stc-row{display:flex;align-items:center;justify-content:space-between;gap:10px}'
      + '.stc-cta{background:var(--accent,#46C2D8);color:#04121a;border:none;border-radius:8px;padding:8px 14px;font-weight:700;font-size:12.5px;cursor:pointer;font-family:inherit}'
      + '.stc-cta:hover{filter:brightness(1.08)}'
      + '.stc-skip{background:none;border:none;color:var(--muted,#8B95AD);font-size:11.5px;cursor:pointer;text-decoration:underline;padding:4px 0;font-family:inherit}'
      + '.stc-skip:hover{color:var(--soft,#C2CAD9)}';
    var style = document.createElement('style');
    style.id = 'sil-tour-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureUI(){
    if(veilEl) return;
    veilEl = document.createElement('div'); veilEl.id = 'sil-tour-veil';
    spotEl = document.createElement('div'); spotEl.id = 'sil-tour-spot';
    calloutEl = document.createElement('div'); calloutEl.className = 'sil-tour-callout';
    document.body.appendChild(veilEl);
    document.body.appendChild(spotEl);
    document.body.appendChild(calloutEl);
    veilEl.addEventListener('click', function(){ finishTour(false); });
  }

  function teardownUI(){
    [veilEl, spotEl, calloutEl].forEach(function(el){ if(el && el.parentNode) el.parentNode.removeChild(el); });
    veilEl = spotEl = calloutEl = null;
  }

  function setHyroxOptionVisible(visible){
    var opt = document.querySelector('#bDiscPick option[value="hyrox"]');
    if(!opt) return;
    opt.hidden = !visible;
    opt.disabled = !visible;
  }

  function renderCallout(step){
    var stepNo = currentIndex + 1;
    var html = '<div class="stc-step">' + tr('tour.stepCounter', {n:stepNo, total:currentSteps().length}) + '</div>'
      + '<div class="stc-title">' + step.title + '</div>'
      + '<div class="stc-text">' + step.text + '</div>';
    if(step.cta){
      html += '<div class="stc-row"><button class="stc-skip" data-stc-skip type="button">' + tr('tour.skip') + '</button><button class="stc-cta" data-stc-cta type="button">' + step.cta + '</button></div>';
    } else {
      html += '<div class="stc-hint"><span class="chev">→</span> ' + tr('tour.clickHighlighted') + '</div>'
        + '<button class="stc-skip" data-stc-skip type="button">' + tr('tour.skip') + '</button>';
    }
    calloutEl.innerHTML = html;
    var ctaBtn = calloutEl.querySelector('[data-stc-cta]');
    if(ctaBtn) ctaBtn.addEventListener('click', advance);
    var skipBtn = calloutEl.querySelector('[data-stc-skip]');
    if(skipBtn) skipBtn.addEventListener('click', function(){ finishTour(false); });
  }

  function positionFor(step, el){
    var margin = 14;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cw = calloutEl.offsetWidth || 290, ch = calloutEl.offsetHeight || 140;

    if(!el){
      spotEl.classList.remove('show');
      veilEl.classList.add('show');
      calloutEl.className = 'sil-tour-callout side-center show';
      calloutEl.style.left = Math.round((vw - cw) / 2) + 'px';
      calloutEl.style.top = Math.round((vh - ch) / 2) + 'px';
      return;
    }

    veilEl.classList.remove('show');
    var r = el.getBoundingClientRect();
    var pad = 6;
    spotEl.style.left = (r.left - pad) + 'px';
    spotEl.style.top = (r.top - pad) + 'px';
    spotEl.style.width = (r.width + pad * 2) + 'px';
    spotEl.style.height = (r.height + pad * 2) + 'px';
    spotEl.classList.add('show');

    var spaceBelow = vh - r.bottom, spaceAbove = r.top, spaceRight = vw - r.right, spaceLeft = r.left;
    var side = 'bottom';
    if(spaceBelow >= ch + margin) side = 'bottom';
    else if(spaceAbove >= ch + margin) side = 'top';
    else if(spaceRight >= cw + margin) side = 'right';
    else if(spaceLeft >= cw + margin) side = 'left';

    var top, left;
    if(side === 'bottom'){ top = r.bottom + margin; left = r.left + r.width / 2 - cw / 2; }
    else if(side === 'top'){ top = r.top - margin - ch; left = r.left + r.width / 2 - cw / 2; }
    else if(side === 'right'){ left = r.right + margin; top = r.top + r.height / 2 - ch / 2; }
    else { left = r.left - margin - cw; top = r.top + r.height / 2 - ch / 2; }

    left = Math.max(margin, Math.min(left, vw - cw - margin));
    top = Math.max(margin, Math.min(top, vh - ch - margin));

    calloutEl.className = 'sil-tour-callout side-' + side + ' show';
    calloutEl.style.left = Math.round(left) + 'px';
    calloutEl.style.top = Math.round(top) + 'px';
  }

  function isRendered(el){ return !!el && el.getClientRects().length > 0; }

  function updatePosition(){
    rafId = null;
    if(!active || !currentStep) return;
    if(!isModeActive(currentTour().modeBtnId)){ finishTour(false); return; }
    var el = qs(currentStep.target);
    if(currentStep.target && !isRendered(el)){ finishTour(false); return; }
    positionFor(currentStep, el);
  }
  // Repositionne au resize/scroll plutôt qu'en boucle sur chaque frame (perf
  // 04/08/2026) : l'ancienne version se rappelait via requestAnimationFrame
  // indéfiniment tant qu'une étape attendait un clic — coûteux en reflow forcé
  // (getBoundingClientRect + écritures de style à chaque frame), mesuré comme
  // la première cause du TBT/LCP tardifs en audit Lighthouse.
  function scheduleReposition(){
    if(!active) return;
    if(rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updatePosition);
  }

  function activateStep(step){
    step._advancing = false;
    currentStep = step;
    renderCallout(step);
    var el = qs(step.target);
    if(step.target && !isRendered(el)){ finishTour(false); return; }
    if(el && el.scrollIntoView) el.scrollIntoView({block:'center', inline:'nearest'});
    positionFor(step, el);
  }

  function advance(){
    currentIndex++;
    var steps = currentSteps();
    if(currentIndex >= steps.length){ finishTour(true); return; }
    activateStep(steps[currentIndex]);
  }

  function onDomEvent(e){
    if(!active || !currentStep || !currentStep.wait) return;
    if(e.type !== currentStep.wait) return;
    var el = e.target && e.target.closest && e.target.closest(currentStep.target);
    if(el){
      if(currentStep.accept && !currentStep.accept(el)) return;
      // Garde-fou : plusieurs événements (ex. plusieurs touches tapées vite
      // dans un champ texte, ou un collé) peuvent matcher la même étape avant
      // que le premier setTimeout n'ait fait avancer le tuto — sans ce drapeau,
      // chaque frappe programme son propre advance() et le tuto saute
      // plusieurs étapes d'un coup. Le drapeau est propre à l'objet étape et
      // se réinitialise naturellement dès qu'on passe à l'étape suivante.
      if(currentStep._advancing) return;
      currentStep._advancing = true;
      setTimeout(advance, 80);
      return;
    }
    // Le clic ne correspond pas à la cible attendue : peut-être un changement
    // de mode (Coach/Club) ou d'onglet club en cours de tuto — si la cible de
    // l'étape a disparu de l'écran, on referme proprement plutôt que de
    // laisser la bulle flotter sur un écran qui n'a plus de rapport avec elle.
    // Capturé en phase capture (avant le handler du bouton cliqué) : le
    // changement de mode/onglet n'a pas encore eu lieu au moment de ce
    // callback, d'où le setTimeout(0) pour revérifier une fois le clic traité.
    if(e.type !== 'click') return;
    var tourAtClick = currentTourId, stepAtClick = currentStep;
    setTimeout(function(){
      if(!active || currentTourId !== tourAtClick || currentStep !== stepAtClick) return;
      if(!isModeActive(currentTour().modeBtnId) || (stepAtClick.target && !isRendered(qs(stepAtClick.target)))){
        finishTour(false);
      }
    }, 0);
  }

  var TOUR_FINISH_TOAST = {
    session: 'tour.finishToast',
    groupes: 'tour.groupes.finishToast',
    suivi: 'tour.suivi.finishToast',
    competitions: 'tour.competitions.finishToast'
  };

  function finishTour(completed){
    var tourId = currentTourId;
    active = false;
    currentStep = null;
    if(rafId) cancelAnimationFrame(rafId);
    rafId = null;
    teardownUI();
    setHyroxOptionVisible(true);
    try{ localStorage.setItem(TOURS[tourId].doneKey, completed ? '1' : 'skipped'); }catch(e){}
    if(completed && typeof global.toast === 'function'){
      global.toast(tr(TOUR_FINISH_TOAST[tourId] || 'tour.finishToast'));
    }
    currentTourId = null;
  }

  function start(tourId){
    if(active) return;
    tourId = tourId || 'session';
    if(!TOURS[tourId]) return;
    injectStyles();
    ensureUI();
    var ov = document.getElementById('builderOverlay');
    if(ov && ov.classList.contains('open') && typeof global.closeBuilder === 'function'){ global.closeBuilder(); }
    setHyroxOptionVisible(false);
    active = true;
    currentTourId = tourId;
    currentIndex = -1;
    advance();
  }

  function isModeActive(modeBtnId){
    var btn = document.getElementById(modeBtnId);
    return !!btn && btn.classList.contains('active');
  }

  // L'écran d'accueil démo (#welcomeOverlay, z-index 200) est bien en dessous
  // du voile du tuto (z-index 99997) : si l'auto-lancement tombait pendant que
  // ce welcome est encore ouvert, le voile du tuto s'affichait par-dessus et
  // rendait son bouton "Commencer à explorer" inatteignable — la page semblait
  // bloquée (rapporté 25/08/2026). On attend sa fermeture avant de démarrer.
  function welcomeOverlayOpen(){
    var ov = document.getElementById('welcomeOverlay');
    return !!ov && getComputedStyle(ov).display !== 'none';
  }

  // Auto-lancement réservé au tour "session" (onboarding création de séance) —
  // les tutos club sont volontairement à déclenchement manuel uniquement, pour
  // ne pas enchaîner plusieurs tours automatiques d'affilée sur un même compte.
  function maybeAutoLaunch(){
    try{
      if(localStorage.getItem(TOURS.session.doneKey)) return;
    }catch(e){ return; }
    function attempt(){
      if(active) return;
      if(!isModeActive(TOURS.session.modeBtnId)) return;
      if(welcomeOverlayOpen()){ setTimeout(attempt, 400); return; }
      start('session');
    }
    setTimeout(attempt, 900);
  }

  function init(){
    injectStyles();
    document.addEventListener('click', onDomEvent, true);
    document.addEventListener('change', onDomEvent, true);
    document.addEventListener('input', onDomEvent, true);
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);
    var btn = document.getElementById('tutoBtn');
    if(btn) btn.addEventListener('click', function(){ start('session'); });
    var btnGroupes = document.getElementById('tutoBtnGroupes');
    if(btnGroupes) btnGroupes.addEventListener('click', function(){ start('groupes'); });
    var btnSuivi = document.getElementById('tutoBtnSuivi');
    if(btnSuivi) btnSuivi.addEventListener('click', function(){ start('suivi'); });
    var btnCompetitions = document.getElementById('tutoBtnCompetitions');
    if(btnCompetitions) btnCompetitions.addEventListener('click', function(){ start('competitions'); });
    maybeAutoLaunch();
  }

  global.SillanceTour = { init: init, start: start };

})(window);
