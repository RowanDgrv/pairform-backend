#!/usr/bin/env node
// =============================================================================
//  Spike COROS MCP — valide la mécanique AVANT de faire confiance à coros-poll.
//  ---------------------------------------------------------------------------
//  COROS n'autorise que le flux "authorization_code + PKCE" (le device grant
//  annoncé dans les métadonnées n'est PAS délivré aux clients DCR — vérifié).
//  Ce script monte donc un mini-serveur local http://127.0.0.1:8975/callback,
//  ouvre l'autorisation dans ton navigateur, récupère le code, l'échange, et
//  exerce EXACTEMENT ce que fait _shared/corosMcp.ts.
//
//    node test/coros-mcp-spike.mjs
//
//  Vert = la logique de corosMcp.ts tient (handshake MCP, SSE, parsing texte).
//  Rouge = on voit précisément où, avant de déployer.
// =============================================================================
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";

const BASE = process.env.COROS_MCP_BASE || "https://mcpeu.coros.com";
const SCOPE = "openid mcp.tools offline_access";
const PROTO = "2025-06-18";
const PORT = 8975;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  // 1. Enregistrement dynamique de client (RFC 7591) — aucun dossier
  const reg = await fetch(`${BASE}/connect/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Sillance (spike)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  }).then((r) => r.json());
  if (!reg.client_id) throw new Error("DCR: " + JSON.stringify(reg));
  console.log("✔ client enregistré :", reg.client_id);

  // 2. PKCE + URL d'autorisation
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const authUrl = `${BASE}/oauth2/authorize?` + new URLSearchParams({
    response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT,
    scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256",
    resource: BASE,
  });

  // 3. Mini-serveur local pour capter le code
  const code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (!u.pathname.startsWith("/callback")) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Sillance × COROS — c'est bon, tu peux fermer cet onglet.</h2>");
      srv.close();
      if (u.searchParams.get("state") !== state) return reject(new Error("state mismatch"));
      const c = u.searchParams.get("code");
      c ? resolve(c) : reject(new Error("callback sans code: " + u.search));
    });
    srv.listen(PORT, () => {
      console.log("\n→ Ouvre cette URL et connecte-toi à COROS :\n", authUrl, "\n");
      exec(`open "${authUrl}" || xdg-open "${authUrl}"`, () => {});
    });
  });
  console.log("✔ code d'autorisation reçu");

  // 4. Échange code → jetons (client public + PKCE)
  const tok = await fetch(`${BASE}/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT,
      client_id: reg.client_id, code_verifier: verifier, resource: BASE,
    }),
  }).then((r) => r.json());
  if (!tok.access_token) throw new Error("token: " + JSON.stringify(tok));
  console.log("✔ jeton (expires_in", tok.expires_in, "· refresh_token", tok.refresh_token ? "oui" : "NON ⚠️", ")");

  // 5. Client MCP minimal — logique identique à corosMcp.ts::rpc/mcpCall
  async function rpc(sid, payload) {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTO,
        ...(sid ? { "Mcp-Session-Id": sid } : {}),
      },
      body: JSON.stringify(payload),
    });
    const newSid = res.headers.get("Mcp-Session-Id") || sid;
    const raw = await res.text();
    if (!res.ok) throw new Error(`MCP ${res.status}: ${raw.slice(0, 300)}`);
    const ct = res.headers.get("Content-Type") || "";
    if (!raw.trim()) return { body: null, sid: newSid };
    if (ct.includes("text/event-stream")) {
      let last = null;
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^data:\s?(.*)$/);
        if (m) { try { const o = JSON.parse(m[1]); if (o && (o.result !== undefined || o.error)) last = o; } catch {} }
      }
      return { body: last, sid: newSid };
    }
    return { body: JSON.parse(raw), sid: newSid };
  }

  const init = await rpc(null, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: "sillance-spike", version: "0" } },
  });
  if (init.body?.error) throw new Error("initialize: " + JSON.stringify(init.body.error));
  console.log("✔ initialize :", JSON.stringify(init.body?.result?.serverInfo || init.body?.result || {}).slice(0, 160));
  const sid = init.sid;
  console.log("  Mcp-Session-Id :", sid ? "fourni (stateful)" : "aucun (stateless)");
  try { await rpc(sid, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }); } catch {}

  const tools = await rpc(sid, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = (tools.body?.result?.tools || []).map((t) => t.name);
  console.log(`✔ tools/list : ${names.length} outils — ${names.slice(0, 8).join(", ")}…`);
  const canWrite = names.some((n) => /generateTrainingPlan|updateTrainingPlan|createWorkout/i.test(n));
  console.log(`  écriture de plans : ${canWrite ? "OUI ✅ → activer pushPlannedSession" : "pas encore (attendu mi-sept. 2026)"}`);

  async function call(name, args) {
    const r = await rpc(sid, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
    if (r.body?.error) throw new Error(`${name}: ${JSON.stringify(r.body.error)}`);
    const res = r.body?.result || {};
    return {
      text: (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      structured: res.structuredContent || null,
    };
  }
  const ymd = (d = 0) => {
    const x = new Date(Date.now() - d * 864e5);
    return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}${String(x.getUTCDate()).padStart(2, "0")}`;
  };

  console.log("\n— querySportRecords (21 j) —");
  const recs = await call("querySportRecords", { startDate: ymd(21), endDate: ymd(0), sportTypeCodes: [65535], limit: 50 });
  console.log("structuredContent :", recs.structured ? "OUI (corosMcp.ts devrait le préférer)" : "non → parsing texte");
  console.log(recs.text.slice(0, 700));

  const m = recs.text.match(/LabelId:\s*(\d+)\s*\|\s*SportType:\s*(\d+)/i);
  if (m) {
    console.log("\n— queryActivityFitFileDownloadUrls —");
    console.log((await call("queryActivityFitFileDownloadUrls", { labelId: m[1], sportType: +m[2] })).text.slice(0, 300));
  }
  console.log("\n— querySleepHrv —");
  console.log((await call("querySleepHrv", { startDate: ymd(2), endDate: ymd(0), days: 3 })).text.slice(0, 400));

  console.log("\n✅ SPIKE OK — corosMcp.ts / coros-poll peuvent être déployés en confiance.");
  process.exit(0);
}
main().catch((e) => { console.error("\n❌", e); process.exit(1); });
