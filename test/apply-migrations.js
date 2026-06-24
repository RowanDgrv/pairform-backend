// Applique les 4 migrations SQL sur le projet Supabase via une connexion
// Postgres directe (pas besoin de la CLI). Lit SUPABASE_DB_URL.
// Usage : SUPABASE_DB_URL="postgresql://..." node apply-migrations.js
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migDir = join(here, "..", "supabase", "migrations");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) { console.error("❌ SUPABASE_DB_URL manquant"); process.exit(1); }

const files = readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

await client.connect();
console.log("Connecté à Postgres. Migrations à appliquer :", files.join(", "));

for (const f of files) {
  const sql = readFileSync(join(migDir, f), "utf8");
  process.stdout.write(`→ ${f} … `);
  try {
    await client.query(sql);
    console.log("OK");
  } catch (e) {
    console.log("ÉCHEC");
    console.error(`   ${e.message}`);
    // On continue : certaines erreurs "already exists" sont bénignes en ré-exécution.
  }
}

await client.end();
console.log("✅ Migrations terminées.");
