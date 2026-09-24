// =============================================================================
//  Edge Function : export-fit-workout (22/09/2026)
//  ---------------------------------------------------------------------------
//  Garmin n'autorise pas l'envoi téléphone → montre d'un fichier de séance
//  structurée (il faut brancher la montre en USB à un ordinateur et copier le
//  .FIT dans /Garmin/NewFiles) ; Coros nécessite un partenariat approuvé pour
//  pousser une séance ; Polar n'expose pas d'API d'envoi. Le seul morceau
//  livrable sans dépendre d'un tiers : générer un vrai fichier .FIT
//  "workout" (structure officielle Garmin FIT SDK) que l'athlète charge
//  ensuite lui-même sur sa montre — voir OFFICIAL_FIT_FIELDS.md du SDK
//  (@garmin/fitsdk) pour les noms de champs utilisés ci-dessous.
//
//  Auth : JWT requis (juste pour éviter l'abus anonyme — la génération ne lit
//  ni n'écrit rien en base, la séance est fournie directement par l'appelant,
//  qui l'a déjà légitimement en main côté client).
//  Body : { title, disc: 'run'|'bike'|'swim', blocks: [...] } (même forme que
//  scheduled_sessions.blocks côté front) — ou { sessions: [...] } pour
//  plusieurs séances (renvoie alors une archive zip, une entrée par séance).
// =============================================================================
import { Encoder, Profile } from "https://esm.sh/@garmin/fitsdk@21.214.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SPORT_BY_DISC: Record<string, string> = {
  run: "running",
  bike: "cycling",
  swim: "swimming",
  strength: "training",
  hyrox: "training",
};

type Line = {
  type?: string;            // 'warmup' | 'exo' | 'contre' | 'recov' | 'cooldown' | 'station'
  mode?: string;            // 'exact' | 'pct' | ...
  metric?: string;          // 'time' | 'dist' | 'reps'
  dur?: { h?: number; m?: number; s?: number };
  dist?: number;            // km
  exact?: { kind: string; tol?: number; w?: number; kmh?: number; rpm?: number; m?: number; s?: number; per100?: boolean; rpe?: number };
};
type Block = { series?: number; lines?: Line[] };
type SessionInput = { title?: string; disc?: string; blocks?: Block[] };

const INTENSITY_BY_TYPE: Record<string, string> = {
  warmup: "warmup",
  cooldown: "cooldown",
  recov: "recovery",
  exo: "active",
  contre: "active",
};

function lineDurationSeconds(ln: Line): number {
  const d = ln.dur || {};
  return (d.h || 0) * 3600 + (d.m || 0) * 60 + (d.s || 0);
}

// Vitesse cible (m/s) à partir d'un ln.exact — la seule notion FIT pour une
// allure course/nage est une vitesse ; un device course affiche l'allure
// convertie lui-même à partir de la vitesse + du sport de l'activité.
function speedFromExact(ex: NonNullable<Line["exact"]>): { center: number; tol: number } | null {
  if (ex.kind === "speed" && ex.kmh != null) {
    return { center: ex.kmh / 3.6, tol: (ex.tol || 0) / 3.6 };
  }
  if (ex.kind === "pace" && ex.m != null) {
    const centerS = (ex.m || 0) * 60 + (ex.s || 0);
    if (centerS <= 0) return null;
    const tolS = ex.tol || 0;
    // plage de vitesse : allure - tol = vitesse la + rapide = borne haute de vitesse
    const fast = Math.max(1, centerS - tolS);
    const slow = centerS + tolS;
    return { center: 1000 / centerS, tol: 0, lowOverride: 1000 / slow, highOverride: 1000 / fast } as any;
  }
  if (ex.kind === "time100" && ex.m != null) {
    const centerS = (ex.m || 0) * 60 + (ex.s || 0);
    if (centerS <= 0) return null;
    const tolS = ex.tol || 0;
    const fast = Math.max(1, centerS - tolS);
    const slow = centerS + tolS;
    return { center: 100 / centerS, tol: 0, lowOverride: 100 / slow, highOverride: 100 / fast } as any;
  }
  return null;
}

// Construit les workoutStep pour UN bloc (avec repeat si series>1) et les
// pousse dans `steps` — chaque step reçoit son messageIndex = steps.length
// AVANT ajout, ce qui donne l'index de bouclage correct pour le repeat.
function pushBlockSteps(steps: Record<string, unknown>[], block: Block) {
  const lines = (block.lines || []).filter((l) => l.type !== "station"); // hyrox hors périmètre
  if (!lines.length) return;
  const firstIndex = steps.length;

  for (const ln of lines) {
    const step: Record<string, unknown> = { messageIndex: steps.length };
    step.intensity = INTENSITY_BY_TYPE[ln.type || ""] || "active";

    if (ln.metric === "dist" && ln.dist) {
      step.durationType = "distance";
      step.durationValue = Math.round(ln.dist * 1000 * 100); // km -> m, scale 100
    } else {
      step.durationType = "time";
      step.durationValue = (lineDurationSeconds(ln) || 60) * 1000; // s, scale 1000
    }

    // IMPORTANT : l'encodeur @garmin/fitsdk n'applique PAS le facteur
    // d'échelle quand on lui donne le nom du sous-champ « ami » (ex.
    // customTargetSpeedLow) — vérifié par test d'aller-retour encode/decode
    // le 22/09/2026 (les valeurs disparaissaient silencieusement). Il faut
    // écrire le champ BRUT (customTargetValueLow) déjà mis à l'échelle ;
    // c'est le decoder qui résout ensuite le sous-champ pour l'affichage.
    const ex = ln.mode === "exact" ? ln.exact : null;
    if (ex && (ex.kind === "speed" || ex.kind === "pace" || ex.kind === "time100")) {
      const sp = speedFromExact(ex);
      if (sp) {
        step.targetType = "speed";
        const low = (sp as any).lowOverride ?? sp.center - sp.tol;
        const high = (sp as any).highOverride ?? sp.center + sp.tol;
        step.customTargetValueLow = Math.round(Math.max(0.1, low) * 1000);   // scale 1000, m/s
        step.customTargetValueHigh = Math.round(Math.max(low + 0.1, high) * 1000);
      } else {
        step.targetType = "open";
      }
    } else if (ex && ex.kind === "power" && ex.w != null) {
      step.targetType = "power";
      const tol = ex.tol || 0;
      // convention FIT : watts absolus = valeur + 1000 (0-1000 = %FTP)
      step.customTargetValueLow = 1000 + Math.max(0, ex.w - tol);
      step.customTargetValueHigh = 1000 + (ex.w + tol);
    } else if (ex && ex.kind === "cadence" && ex.rpm != null) {
      step.targetType = "cadence";
      const tol = ex.tol || 0;
      step.customTargetValueLow = Math.max(0, ex.rpm - tol);
      step.customTargetValueHigh = ex.rpm + tol;
    } else {
      step.targetType = "open";
    }

    steps.push(step);
  }

  const series = block.series || 1;
  if (series > 1) {
    steps.push({
      messageIndex: steps.length,
      durationType: "repeatUntilStepsCmplt",
      durationValue: firstIndex,   // durationStep (index du step de bouclage), scale 1
      targetType: "open",
      targetValue: series,         // repeatSteps (nb de répétitions), scale 1
    });
  }
}

function buildFitWorkout(session: SessionInput): Uint8Array {
  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: "workout",
    manufacturer: "development",
    product: 0,
    timeCreated: new Date(),
    serialNumber: Math.floor(Math.random() * 0xffffffff),
  });

  const steps: Record<string, unknown>[] = [];
  for (const block of session.blocks || []) pushBlockSteps(steps, block);
  if (!steps.length) {
    steps.push({ messageIndex: 0, durationType: "open", targetType: "open", intensity: "active" });
  }

  encoder.onMesg(Profile.MesgNum.WORKOUT, {
    sport: SPORT_BY_DISC[session.disc || "run"] || "running",
    numValidSteps: steps.length,
    wktName: (session.title || "Séance Sillance").slice(0, 30),
  });
  for (const step of steps) encoder.onMesg(Profile.MesgNum.WORKOUT_STEP, step);

  return encoder.close();
}

function safeFileName(s: string): string {
  const ascii = (s || "seance").normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return ascii.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "seance";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const body = await req.json().catch(() => ({}));
    const session: SessionInput | undefined = body.session;
    if (!session || !Array.isArray(session.blocks)) {
      return json({ error: "session (avec blocks) requis" }, 400);
    }

    const bytes = buildFitWorkout(session);
    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFileName(session.title || "seance")}.fit"`,
      },
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Erreur serveur", detail: String(e).slice(0, 300) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
