// =============================================================================
//  Edge Function : sillance-mcp (30/10/2026)        déployer avec --no-verify-jwt
//  ---------------------------------------------------------------------------
//  Connecteur Claude « distant » (MCP, transport Streamable HTTP, réponses
//  JSON sans session) : s'ajoute une fois sur claude.ai → Personnaliser →
//  Connecteurs, puis fonctionne aussi dans l'app Claude du téléphone.
//
//  Adresse : …/functions/v1/sillance-mcp/<clé assistant>
//  La clé (assistant_tokens, celle de l'API personnelle) est DANS l'URL car
//  les connecteurs personnalisés sans OAuth n'envoient pas d'en-tête : l'URL
//  est donc un secret (révocable : assistant_tokens.revoked_at). Utiliser une
//  clé dédiée (label « claude-connecteur »), en LECTURE SEULE.
//
//  Les données viennent de assistant-api (même périmètre : UN athlète, celui
//  de la clé) : ce connecteur ne fait que traduire MCP ↔ REST.
// =============================================================================
const BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1/assistant-api`;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
};
const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

type Tool = { name: string; description: string; path: (a: Record<string, unknown>) => string; schema: Record<string, unknown> };
const TOOLS: Tool[] = [
  { name: "sillance_resume", description: "Vue d'ensemble Sillance : séance du jour, semaine à venir, dernier check-in (sommeil, jambes, motivation, VFC), récupération COROS, charge (ACWR, CTL, TSB), activités récentes, références.", path: () => "summary", schema: {} },
  { name: "sillance_seances", description: "Séances planifiées entre deux dates (structure, zones, durée). Par défaut : aujourd'hui → +6 jours.",
    path: (a) => { const f = String(a.from || today()); return `sessions?from=${f}&to=${String(a.to || addDays(f, 6))}`; },
    schema: { from: { type: "string", description: "Date de début AAAA-MM-JJ" }, to: { type: "string", description: "Date de fin AAAA-MM-JJ" } } },
  { name: "sillance_checkins", description: "Check-ins matinaux récents : qualité du sommeil, jambes lourdes, motivation (notes /10), VFC, disponibilité.",
    path: (a) => `checkins?days=${Math.min(60, Number(a.days) || 7)}`, schema: { days: { type: "number", description: "Nombre de jours (défaut 7)" } } },
  { name: "sillance_forme", description: "État de forme issu de la montre COROS : VFC de la nuit, récupération, charge.", path: () => "wellness", schema: {} },
  { name: "sillance_activites", description: "Activités réalisées (COROS, Strava) sur les derniers jours.",
    path: (a) => `activities?days=${Math.min(90, Number(a.days) || 14)}`, schema: { days: { type: "number", description: "Nombre de jours (défaut 14)" } } },
  { name: "sillance_references", description: "Références physiologiques : FTP, PMA, VMA, allure seuil, CSS, FC max et repos.", path: () => "refs", schema: {} },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const rpc = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => json({ jsonrpc: "2.0", id, error: { code, message } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Pas de flux SSE côté serveur : réponses JSON uniquement (autorisé par la spec).
  if (req.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: CORS });
  if (req.method === "DELETE") return new Response(null, { status: 204, headers: CORS });

  const token = new URL(req.url).pathname.replace(/^.*\/sillance-mcp\/?/, "").split("/")[0];
  if (!/^sil_[0-9a-f]{64}$/.test(token)) return json({ error: "Adresse de connecteur invalide" }, 401);

  const msg = await req.json().catch(() => null);
  if (!msg || typeof msg !== "object") return rpcErr(null, -32700, "JSON invalide");
  if (Array.isArray(msg)) return rpcErr(null, -32600, "Lots non pris en charge");
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Record<string, unknown> };
  if (id === undefined || id === null) return new Response(null, { status: 202, headers: CORS }); // notification

  try {
    if (method === "initialize") {
      // Vérifie la clé dès la connexion (message clair dans Claude si révoquée).
      const probe = await fetch(`${BASE}/refs`, { headers: { Authorization: `Bearer ${token}` } });
      if (probe.status === 401) return rpcErr(id, -32001, "Clé Sillance révoquée ou invalide");
      return rpc(id, {
        protocolVersion: (params?.protocolVersion as string) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "sillance", version: "1.0.0" },
        instructions: "Données d'entraînement Sillance (lecture seule). Pour savoir s'il faut adapter la séance du jour : sillance_resume, puis sillance_forme et sillance_checkins. Ne jamais inventer une valeur absente.",
      });
    }
    if (method === "ping") return rpc(id, {});
    if (method === "tools/list") {
      return rpc(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description,
        inputSchema: { type: "object", properties: t.schema }, annotations: { readOnlyHint: true } })) });
    }
    if (method === "tools/call") {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) return rpcErr(id, -32602, `Outil inconnu : ${params?.name}`);
      const res = await fetch(`${BASE}/${t.path((params?.arguments as Record<string, unknown>) || {})}`, { headers: { Authorization: `Bearer ${token}` } });
      const text = res.status === 401 ? "Clé Sillance révoquée ou invalide." : res.ok ? await res.text() : `Erreur Sillance ${res.status}`;
      return rpc(id, { content: [{ type: "text", text }], isError: !res.ok });
    }
    return rpcErr(id, -32601, `Méthode non gérée : ${method}`);
  } catch (e) {
    console.error(e);
    return rpcErr(id, -32000, "Erreur serveur");
  }
});
