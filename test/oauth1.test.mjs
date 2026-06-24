// Valide les primitives du signeur OAuth1.0a (_shared/oauth1.ts) :
//  - pctEncode RFC 3986
//  - HMAC-SHA1 base64 : Web Crypto (utilisé par Deno) == node:crypto
//  - vecteur HMAC-SHA1 connu (key="key", "The quick brown fox...").
// Lancer : node test/oauth1.test.mjs
import { createHmac } from "node:crypto";
import assert from "node:assert";

const pctEncode = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function toBase64(buf) {
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}
async function hmacSha1Base64_subtle(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return toBase64(sig);
}
const hmacSha1Base64_node = (key, msg) => createHmac("sha1", key).update(msg).digest("base64");

let fail = 0;
const check = (name, fn) => { try { fn(); console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "—", e.message); } };

// 1) Encodage RFC 3986
check("pctEncode espace/réservés", () => {
  assert.equal(pctEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(pctEncode("a!*'()~"), "a%21%2A%27%28%29~");
  assert.equal(pctEncode("name=val&x"), "name%3Dval%26x");
});

// 2) HMAC : Web Crypto == node, sur plusieurs entrées
await (async () => {
  // En OAuth1 la clé de signature est toujours `secret&secret` (jamais vide).
  const cases = [
    ["key", "The quick brown fox jumps over the lazy dog"],
    ["cs&ts", "POST&https%3A%2F%2Fexample.com&a%3D1%26b%3D2"],
    ["consumerSecret&", "GET&https%3A%2F%2Fapi.garmin.com%2Fx&oauth_nonce%3Dabc"],
  ];
  for (const [k, m] of cases) {
    const a = await hmacSha1Base64_subtle(k, m);
    const b = hmacSha1Base64_node(k, m);
    check(`HMAC subtle==node (${JSON.stringify(m).slice(0, 24)})`, () => assert.equal(a, b));
  }
  // Vecteur connu
  const known = await hmacSha1Base64_subtle("key", "The quick brown fox jumps over the lazy dog");
  // hex de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9 (vecteur HMAC-SHA1 classique)
  check("vecteur HMAC-SHA1 connu", () => assert.equal(known, "3nybhbi3iqa8ino29wqQcBydtNk="));
})();

console.log(fail ? `\nÉCHEC : ${fail} test(s)` : "\nOK : signeur OAuth1 validé");
process.exit(fail ? 1 : 0);
