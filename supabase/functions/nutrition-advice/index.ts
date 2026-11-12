// =============================================================================
//  Edge Function : nutrition-advice (12/11/2026) — option Assistant IA
//  Propose au coach des consignes d'alimentation AVANT, PENDANT et APRÈS une
//  séance, qu'il relit et modifie avant enregistrement (rien n'est envoyé à
//  l'athlète sans passer par le coach). Modèle : le circuit IA existant de
//  Sillance (_shared/ai.ts : Groq en principal, Anthropic en secours), donc les
//  mêmes sous-traitants que les résumés de séance, déjà déclarés dans legal.html.
//  Auth : JWT ; réservé aux coachs avec l'option Assistant IA (has_ai_addon).
//  Données envoyées : sport, durée, structure et intensité de la séance, et le
//  poids de l'athlète s'il est connu et que l'athlète n'a pas refusé l'analyse
//  IA. Jamais de nom ni d'e-mail.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { effortPct } from "../_shared/intensity.ts";
import { generateJson, AiError } from "../_shared/ai.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SYSTEM = `Tu es nutritionniste du sport et conseilles un entraîneur d'endurance (triathlon, course à pied, vélo, natation, Hyrox).
Tu reçois UNE séance et tu rédiges des consignes d'alimentation pratiques, en français, tutoiement, ton simple, sans emoji.
Appuie-toi sur les repères établis (position commune ACSM / Académie de nutrition et diététique / Diététistes du Canada 2016, position de l'ISSN) :
- Avant : séance facile ou de moins de 60 min = rien d'obligatoire, une collation légère si faim ; séance intense ou longue = repas riche en glucides 2 à 4 h avant, dosé selon la durée : environ 1 g/kg pour une séance d'environ 1 h, 1,5 à 2 g/kg jusqu'à 2 h, 3 à 4 g/kg seulement avant un effort de plus de 2 h 30, peu de fibres et de graisses ; collation glucidique 30 à 60 min avant si besoin.
- Pendant : moins de 60 min = eau seulement ; 1 h à 2 h 30 = 30 à 60 g de glucides par heure ; au-delà de 2 h 30 = jusqu'à 90 g/h (mélange glucose-fructose, à entraîner) ; boire selon la soif et la chaleur, ajouter du sodium si effort long ou chaud.
- Après : séance intense ou longue, ou deux séances dans la journée = glucides (environ 1 g/kg dans l'heure) et 20 à 30 g de protéines (environ 0,3 g/kg) ; séance facile = un repas normal suffit.
Si le poids est donné, convertis en grammes concrets ; sinon donne des fourchettes et des exemples d'aliments.
Natation : pas d'apport pendant sauf séance de plus de 90 min. Musculation : insiste sur les protéines après.
Ne pose aucun diagnostic, ne parle pas de compléments autres que boissons, gels et barres. Chaque consigne fait au plus 2 phrases.
Réponds UNIQUEMENT avec un objet JSON : {"pre": "...", "during": "...", "post": "..."}.`;

// deno-lint-ignore no-explicit-any
function describe(s: any, refs: any): string {
  const SP: Record<string, string> = { run: "course à pied", bike: "vélo", swim: "natation", strength: "musculation", hyrox: "Hyrox", tri: "triathlon" };
  const lines: string[] = [];
  // deno-lint-ignore no-explicit-any
  for (const b of (Array.isArray(s.blocks) ? s.blocks : []) as any[]) {
    // deno-lint-ignore no-explicit-any
    const parts = (b.lines || []).map((l: any) => {
      const d = l.dur ? `${(l.dur.h || 0) * 60 + (l.dur.m || 0)} min${l.dur.s ? " " + l.dur.s + " s" : ""}` : l.dist ? `${l.dist} m` : l.reps ? `${l.reps} répétitions` : "";
      const i = l.mode === "exact" && l.exact?.kind === "pace" ? `allure ${l.exact.m}:${String(l.exact.s).padStart(2, "0")}/km` : l.pct ? `${l.pct} % ${l.model || ""}` : "";
      return [l.type, d, i].filter(Boolean).join(" ");
    });
    lines.push(`${b.series > 1 ? b.series + " × " : ""}${b.title || "bloc"} : ${parts.join(" ; ")}`);
  }
  const eff = effortPct(s.blocks, s.disc, refs || {});
  return [`Sport : ${SP[s.disc] || s.disc}`, `Titre : ${s.title || ""}`, `Durée totale : ${s.dur || "?"} min`, `Zone dominante : ${s.zone || "?"}`,
    eff != null ? `Intensité de la partie la plus dure : ${Math.round(eff)} % ${s.disc === "run" ? "de VMA" : s.disc === "bike" ? "de FTP" : "de FC max"}` : "",
    lines.length ? `Structure :\n${lines.join("\n")}` : ""].filter(Boolean).join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: u } = await sb.auth.getUser(jwt); const uid = u?.user?.id;
    if (!uid) return json({ error: "unauthorized" }, 401);
    const { data: ok } = await sb.rpc("has_ai_addon", { uid });
    if (!ok) return json({ error: "add_on_required" }, 402);

    const body = await req.json().catch(() => ({}));
    // la séance vient soit de la base (id), soit du constructeur (pas encore enregistrée)
    // deno-lint-ignore no-explicit-any
    let s: any = body.session || null, athleteId: string | null = body.athlete_id || null;
    if (body.session_id) {
      const { data } = await sb.from("scheduled_sessions").select("athlete_id, created_by, disc, title, dur, zone, blocks").eq("id", body.session_id).maybeSingle();
      if (!data) return json({ error: "not_found" }, 404);
      s = data; athleteId = data.athlete_id;
    }
    if (!s || !s.disc) return json({ error: "bad_request" }, 400);
    let refs = null, weight: number | null = null;
    if (athleteId) {
      // seulement pour soi-même ou un athlète que l'on coache
      if (athleteId !== uid) { const { data: link } = await sb.from("coach_athlete").select("id").eq("coach_id", uid).eq("athlete_id", athleteId).eq("status", "active").maybeSingle(); if (!link) return json({ error: "forbidden" }, 403); }
      const { data: ap } = await sb.from("athlete_profiles").select("vma, seuil_run, ftp, pma, fc_max, ai_consent").eq("user_id", athleteId).maybeSingle();
      if (ap?.ai_consent === false) return json({ error: "athlete_refused", message: "L'athlète a désactivé l'analyse par l'assistant IA." }, 403);
      refs = ap;
      const { data: ck } = await sb.from("checkins").select("poids").eq("athlete_id", athleteId).not("poids", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      weight = Number(ck?.poids) || null;
    }
    const prompt = describe(s, refs) + (weight ? `\nPoids de l'athlète : ${Math.round(weight)} kg` : "\nPoids de l'athlète : inconnu");
    let out: Record<string, unknown>, model: string;
    try { ({ value: out, model } = await generateJson(SYSTEM, prompt, 600)); }
    catch (e) { console.error("[nutrition-advice] IA", e instanceof AiError ? JSON.stringify(e.attempts) : e); return json({ error: "provider_error" }, 502); }
    const clean = (x: unknown) => String(x ?? "").replace(/[<>]/g, "").trim().slice(0, 400);
    return json({ pre: clean(out.pre), during: clean(out.during), post: clean(out.post), model, weight_used: !!weight });
  } catch (e) { console.error("[nutrition-advice]", e); return json({ error: "server_error" }, 500); }
});
