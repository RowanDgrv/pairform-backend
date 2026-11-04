// =============================================================================
//  _shared/morningCopy.ts — textes variés du rappel du matin (05/11/2026)
//  ---------------------------------------------------------------------------
//  Demande Rowan : un mail du matin différent chaque jour, plus personnel que
//  « Salut X, voilà ce qui t'attend aujourd'hui ». On choisit objet,
//  salutation, accroche, annonce du matériel et conclusion selon :
//    · le type de séance (intense, longue, facile, récup, natation, muscu,
//      double séance) ;
//    · le jour (lundi, vendredi, week-end) ;
//    · la présence d'un coach (il signe le mail).
//  Rotation déterministe : index = (jour + empreinte de l'athlète) % taille,
//  donc deux jours consécutifs ne donnent jamais la même phrase, et un renvoi
//  le même jour donne la même. Aucun tiret long dans les textes.
// =============================================================================

export type CopySession = { title: string; disc: string; dur: number; zone: string | null };
export type CopyContext = { firstName: string | null; coachFirstName: string | null; day: string; userId: string };

const INTENSE_RE = /vma|vo2|seuil|intervalle|fractionn|lt2|tempo|allure|30\/30/i;

export function sessionKind(sessions: CopySession[]): string {
  if (sessions.length > 1) return "multi";
  const s = sessions[0];
  const t = (s.title || "").toLowerCase();
  if (s.disc === "strength") return "strength";
  if (s.disc === "swim") return "swim";
  if ((s.dur ?? 0) >= 120 || /longue|\bld\b|sortie longue/.test(t)) return "long";
  if (["Z4", "Z5"].includes(s.zone ?? "") || INTENSE_RE.test(t)) return "intense";
  if (s.zone === "Z1" || /r[ée]cup|d[ée]crassage/.test(t)) return "recup";
  return "easy";
}

// {s} = séance(s) du jour, {coach} = prénom du coach (phrases ignorées sans coach)
const INTROS: Record<string, string[]> = {
  intense: [
    "Grosse séance aujourd'hui : {s}. C'est le genre de séance qui fait progresser, alors arrive frais.",
    "Aujourd'hui on monte d'un cran avec {s}. Prends vraiment le temps de bien t'échauffer.",
    "Séance de qualité au programme : {s}. Vise la régularité plutôt qu'une première répétition trop rapide.",
    "{coach} t'a préparé une séance de qualité : {s}. Hydrate-toi bien dès ce matin.",
    "C'est jour d'intensité : {s}. Le genre de séance dont on est fier une fois finie.",
    "Au menu : {s}. Écoute tes sensations sur les premières répétitions, puis installe-toi dans le rythme.",
  ],
  long: [
    "Sortie longue aujourd'hui : {s}. Pars tranquille, c'est la durée qui compte.",
    "Grosse durée au programme : {s}. Pense à manger avant d'avoir faim et à boire avant d'avoir soif.",
    "{s} aujourd'hui. Le secret d'une bonne sortie longue : partir plus doucement que ce que tu crois.",
    "Aujourd'hui, on construit le fond : {s}. Prévois de quoi boire et manger pour toute la sortie.",
    "{coach} a prévu du volume aujourd'hui : {s}. Garde de l'énergie pour la dernière heure.",
  ],
  easy: [
    "Séance tranquille aujourd'hui : {s}. L'aisance, c'est le seul objectif.",
    "Au programme : {s}. Une séance facile qui prépare les prochaines.",
    "Aujourd'hui c'est {s}, sans forcer. Tu dois pouvoir tenir une conversation.",
    "{s} aujourd'hui. Les séances faciles font progresser aussi, à condition de les garder faciles.",
    "{coach} t'a prévu une séance en douceur : {s}. Profite.",
  ],
  recup: [
    "Journée de récupération active : {s}. Tout doux, c'est le moment où ton corps assimile le travail.",
    "{s} aujourd'hui, en mode récup. Si les jambes sont lourdes, c'est normal : reste vraiment facile.",
    "Aujourd'hui, on récupère : {s}. Moins tu en fais, mieux c'est.",
    "Séance de décrassage au programme : {s}. Rien à prouver aujourd'hui.",
  ],
  swim: [
    "Direction le bassin : {s}.",
    "Aujourd'hui, ça se passe dans l'eau : {s}.",
    "Séance de natation au programme : {s}. Vérifie ton sac avant de partir, le maillot en premier.",
    "{coach} t'attend dans l'eau aujourd'hui : {s}.",
    "Au programme ce jour : {s}. Concentre-toi sur la qualité de nage, la vitesse suivra.",
  ],
  strength: [
    "Séance de renforcement aujourd'hui : {s}. La qualité des mouvements avant la charge.",
    "Au programme : {s}. Prends le temps de bien t'échauffer les articulations.",
    "{s} aujourd'hui. Mieux vaut une répétition propre de moins qu'une de trop mal faite.",
  ],
  multi: [
    "Double séance aujourd'hui : {s}. Organise bien ta journée pour récupérer entre les deux.",
    "Deux séances au programme : {s}. Pense à manger et à boire entre les deux.",
    "Journée chargée : {s}. Garde de l'énergie pour la deuxième.",
    "{coach} t'a prévu deux séances : {s}. Une bonne collation entre les deux et ça va bien se passer.",
  ],
};

const SUBJECTS: Record<string, string[]> = {
  intense: ["Séance de qualité aujourd'hui : {t}", "Aujourd'hui on monte d'un cran", "{t} t'attend aujourd'hui", "Jour d'intensité : {t}"],
  long: ["Sortie longue au programme", "Grosse durée aujourd'hui : {t}", "Aujourd'hui, on construit le fond"],
  easy: ["Ta séance du jour : {t}", "Tranquille aujourd'hui : {t}", "Au programme aujourd'hui : {t}"],
  recup: ["Journée récup : {t}", "Aujourd'hui, on récupère", "Tout doux aujourd'hui : {t}"],
  swim: ["Direction le bassin : {t}", "Natation aujourd'hui : {t}", "Ton sac de piscine est prêt ?"],
  strength: ["Renforcement aujourd'hui : {t}", "Ta séance de renfo du jour"],
  multi: ["Double séance aujourd'hui", "Deux séances au programme aujourd'hui", "Grosse journée d'entraînement"],
};

const GREETINGS = ["Salut {p},", "Bonjour {p},", "Hello {p},", "Salut {p} !"];
const GREETINGS_NONAME = ["Salut,", "Bonjour,", "Hello,"];

const WEEKDAY_LINES: Record<number, string[]> = {
  1: ["Nouvelle semaine, nouvelles séances.", "On attaque la semaine.", "Bon début de semaine !"],
  5: ["Dernier jour avant le week-end.", "Vendredi, la semaine se termine bien."],
  6: ["Bon samedi !", "C'est le week-end, profites-en."],
  0: ["Bon dimanche !", "Profite de ton dimanche."],
};

const GEAR_LABELS = ["À mettre dans ton sac :", "N'oublie pas :", "Dans ton sac aujourd'hui :", "À prendre avec toi :", "Ta liste du jour :"];
const NUTRI_LABELS = ["Côté nutrition :", "Pour l'énergie :", "Côté assiette :"];

const CLOSINGS: Record<string, string[]> = {
  intense: ["Courage, ça vaut le coup.", "Donne tout, mais garde de quoi finir la dernière.", "Bonne séance, ce soir elle sera dans la poche."],
  long: ["Profite du paysage.", "Bonne sortie, et prends ton temps.", "Profite bien, c'est toi qui fixes le rythme."],
  default: ["Bonne séance !", "Fais-toi plaisir.", "Profite bien.", "Raconte comment ça s'est passé dans l'appli, ça aide pour la suite.", "Bonne journée et bonne séance."],
};

function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function dayIndex(isoDay: string): number { return Math.floor(Date.parse(isoDay + "T12:00:00Z") / 86400000); }
// rotation : deux jours consécutifs → deux éléments différents (si la liste en a 2+)
function pick<T>(list: T[], ctx: CopyContext, salt: string): T {
  return list[(dayIndex(ctx.day) + hash(ctx.userId + salt)) % list.length];
}
function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export type MorningCopy = { subject: string; greeting: string; weekdayLine: string | null; intro: string; gearLabel: string; nutriLabel: string; closing: string; signature: string };

export function morningCopy(sessions: CopySession[], ctx: CopyContext): MorningCopy {
  const kind = sessionKind(sessions);
  const seance = sessions.length > 1
    ? sessions.map((s) => s.title).join(" puis ")
    : sessions[0].title;
  const vars = { s: seance, t: sessions[0].title, coach: ctx.coachFirstName ?? "", p: ctx.firstName ?? "" };
  // sans coach : on écarte les phrases qui le citent
  const intros = (INTROS[kind] ?? INTROS.easy).filter((x) => ctx.coachFirstName || !x.includes("{coach}"));
  const wd = new Date(ctx.day + "T12:00:00Z").getUTCDay();
  const wdLines = WEEKDAY_LINES[wd];
  return {
    subject: fill(pick(SUBJECTS[kind] ?? SUBJECTS.easy, ctx, "subj"), vars),
    greeting: fill(pick(ctx.firstName ? GREETINGS : GREETINGS_NONAME, ctx, "greet"), vars),
    // un jour sur deux environ, pour ne pas en faire une formule
    weekdayLine: wdLines && (dayIndex(ctx.day) + hash(ctx.userId)) % 2 === 0 ? pick(wdLines, ctx, "wd") : null,
    intro: fill(pick(intros, ctx, "intro"), vars),
    gearLabel: pick(GEAR_LABELS, ctx, "gear"),
    nutriLabel: pick(NUTRI_LABELS, ctx, "nutri"),
    closing: pick(CLOSINGS[kind] ?? CLOSINGS.default, ctx, "close"),
    signature: ctx.coachFirstName ?? "L'équipe Sillance",
  };
}
