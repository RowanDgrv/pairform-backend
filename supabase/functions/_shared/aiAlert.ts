// =============================================================================
//  _shared/aiAlert.ts — Alerte « analyse IA échouée » (28/10/2026)
//  Demande de Rowan : si un utilisateur (ou lui-même) n'obtient pas son
//  analyse IA, il reçoit tout de suite un email qui dit QUI, QUOI et OÙ ça a
//  planté. Chaque échec est aussi journalisé dans ai_failures (0073).
//  Anti-spam : au plus 1 email par utilisateur et par fonction toutes les
//  30 min (les échecs suivants sont journalisés, pas renvoyés par email).
//  Jamais bloquant : une alerte qui échoue ne casse pas la réponse à l'app.
// =============================================================================
import { sendEmail } from "./email.ts";
import { AiError, type AiAttempt } from "./ai.ts";

// deno-lint-ignore no-explicit-any
type Supa = any;

const STAGE_LABEL: Record<string, string> = {
  addon: "Vérification de l'add-on IA",
  cache: "Lecture du cache",
  ia: "Appel au fournisseur d'IA",
  save: "Enregistrement du résultat (l'utilisateur a quand même eu son analyse)",
  browser: "Navigateur → serveur : la requête n'a jamais abouti",
  unknown: "Étape inconnue",
};
const FN_LABEL: Record<string, string> = {
  "session-summary": "Analyse d'une séance",
  "week-review": "Analyse de la semaine",
  "session-report": "Rapport complet de séance",
};

function adminEmails(): string[] {
  const list = (Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ["contact@sillance.app"];
}

// Piste de correction lisible pour chaque code d'erreur.
function hint(detail: string): string {
  const h: string[] = [];
  if (/groq_401|groq_403/.test(detail)) h.push("Clé Groq refusée : vérifie GROQ_API_KEY (console.groq.com → API Keys).");
  if (/groq_429/.test(detail)) h.push("Limite de débit Groq atteinte (offre gratuite) : attendre, ou passer à l'offre payante Groq.");
  if (/groq_404|model_not_found|model_decommissioned/.test(detail)) h.push("Modèle Groq retiré : changer le secret GROQ_MODEL (console.groq.com/docs/models).");
  if (/anthropic_credit/.test(detail)) h.push("Crédit API Claude épuisé : console.anthropic.com → Billing (distinct de l'abonnement Claude).");
  if (/anthropic_401/.test(detail)) h.push("Clé Claude refusée : vérifie ANTHROPIC_API_KEY.");
  if (/missing_key/.test(detail)) h.push("Aucune clé IA configurée : poser GROQ_API_KEY dans les secrets Supabase.");
  if (/bad_output/.test(detail)) h.push("L'IA a répondu dans un format illisible : souvent ponctuel, sinon revoir le prompt.");
  if (/timeout/.test(detail)) h.push("Le fournisseur n'a pas répondu en 30 s.");
  if (/^network/.test(detail)) h.push("Le navigateur n'a reçu aucune réponse : fonction coupée (temps/mémoire), coupure réseau ou extension qui bloque. Voir les logs Supabase de la fonction.");
  return h.length ? h.join("<br>") : "Voir les logs Supabase de la fonction.";
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function alertAiFailure(supabase: Supa, o: {
  fn: string; stage: string; userId: string | null; detail: string;
  error?: unknown; context?: Record<string, unknown>;
}): Promise<void> {
  try {
    const attempts: AiAttempt[] = o.error instanceof AiError ? o.error.attempts : [];
    const rawError = o.error instanceof AiError ? "" : String((o.error as Error)?.message ?? o.error ?? "").slice(0, 600);

    // Anti-spam (si la table existe ; sinon on alerte quand même).
    let throttled = false;
    if (o.userId) {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: recent, error: rErr } = await supabase.from("ai_failures").select("id")
        .eq("user_id", o.userId).eq("fn", o.fn).eq("alerted", true).gte("created_at", since).limit(1);
      if (!rErr && recent?.length) throttled = true;
    }

    await supabase.from("ai_failures").insert({
      user_id: o.userId, fn: o.fn, stage: o.stage, detail: o.detail,
      attempts, error: rawError || null, context: o.context ?? null, alerted: !throttled,
    }).then(({ error }: { error: unknown }) => { if (error) console.warn("[aiAlert] journal:", error); });

    if (throttled) return;

    let who = "Utilisateur inconnu";
    if (o.userId) {
      const { data: p } = await supabase.from("profiles").select("full_name, email, role").eq("id", o.userId).maybeSingle();
      if (p) who = `${p.full_name || "(sans nom)"} · ${p.email} · ${p.role}`;
    }
    const when = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
    const ref = "onbsgohvqejccowfnrbs";
    const row = (k: string, v: string) =>
      `<tr><td style="padding:6px 10px;color:#6b7682;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 10px">${v}</td></tr>`;
    const attemptsHtml = attempts.length
      ? attempts.map((a) => `<li><b>${esc(a.provider)}</b> (${esc(a.model)}) : <code>${esc(a.error)}</code></li>`).join("")
      : (rawError ? `<li><code>${esc(rawError)}</code></li>` : "<li>Aucun détail côté serveur.</li>");

    const html = `
    <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:620px;margin:0 auto;color:#0f1720">
      <h2 style="font-weight:800;color:#c0392b">Analyse IA échouée</h2>
      <p><b>${esc(who)}</b> n'a pas pu voir son analyse IA.</p>
      <table style="border-collapse:collapse;font-size:14px;width:100%;background:#f6f8fa;border-radius:8px">
        ${row("Quand", esc(when))}
        ${row("Analyse", esc(FN_LABEL[o.fn] ?? o.fn))}
        ${row("Où ça a planté", `<b>${esc(STAGE_LABEL[o.stage] ?? o.stage)}</b>`)}
        ${row("Code", `<code>${esc(o.detail)}</code>`)}
        ${o.context ? row("Contexte", `<code>${esc(JSON.stringify(o.context))}</code>`) : ""}
        ${row("Utilisateur (id)", `<code>${esc(o.userId ?? "-")}</code>`)}
      </table>
      <h3 style="margin-top:20px">Ce que disent les fournisseurs</h3>
      <ul style="line-height:1.6">${attemptsHtml}</ul>
      <h3>Piste</h3>
      <p>${hint(o.detail)}</p>
      <p style="margin-top:22px"><a href="https://supabase.com/dashboard/project/${ref}/functions/${encodeURIComponent(o.fn)}/logs"
        style="background:#0e7c8c;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:9px;display:inline-block">Ouvrir les logs de la fonction</a></p>
      <p style="font-size:12px;color:#6b7682;margin-top:20px">Au plus un email par utilisateur et par analyse toutes les 30 min ; les échecs suivants sont journalisés dans la table ai_failures.</p>
    </div>`;

    await Promise.all(adminEmails().map((to) => sendEmail({
      to, subject: `🚨 Sillance : analyse IA échouée pour ${who.split(" · ")[0]}`, html,
    })));
  } catch (e) {
    console.error("[aiAlert] alerte impossible :", e);
  }
}
