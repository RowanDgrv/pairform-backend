// Test end-to-end du flux PairForm contre le projet Supabase cloud.
// Reproduit exactement les appels que fait l'app (mêmes tables/fonctions).
// Lit : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "@supabase/supabase-js";

const URL  = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SVC) { console.error("❌ SUPABASE_URL / ANON / SERVICE_ROLE manquants"); process.exit(1); }

const admin = createClient(URL, SVC, { auth: { persistSession: false } });
const anon  = createClient(URL, ANON, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok  = (m) => { console.log("  ✅", m); pass++; };
const bad = (m) => { console.log("  ❌", m); fail++; };
const check = (cond, m) => cond ? ok(m) : bad(m);

const email = `e2e+${Date.now()}@pairform.test`;
const password = "Test1234!pf";
let userId;

try {
  console.log("\n1) Inscription (déclenche le trigger handle_new_user)");
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: "E2E Tester", role: "coach" },
  });
  if (cErr) throw cErr;
  userId = created.user.id;
  ok(`utilisateur créé : ${userId}`);

  // le trigger doit avoir créé un profil
  const { data: prof } = await admin.from("profiles").select("*").eq("id", userId).single();
  check(prof && prof.role === "coach", "profil auto-créé avec role=coach");

  console.log("\n2) Connexion en tant qu'utilisateur (RLS active)");
  const { data: signIn, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw sErr;
  const userClient = createClient(URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  });
  ok("connecté, client RLS prêt");

  console.log("\n3) seed_demo() — remplit les données de test");
  const { error: seedErr } = await userClient.rpc("seed_demo", { p_user: userId });
  check(!seedErr, `seed_demo exécuté ${seedErr ? "(" + seedErr.message + ")" : ""}`);

  console.log("\n4) Lecture des données hydratées (via RLS)");
  const { data: recs } = await userClient.from("records").select("*").eq("athlete_id", userId);
  check(recs && recs.length === 4, `records lus : ${recs?.length ?? 0} (attendu 4)`);

  const today = new Date().toISOString().slice(0, 10);
  const { data: ci } = await userClient.from("checkins").select("*").eq("athlete_id", userId).eq("date", today).maybeSingle();
  check(ci && ci.sommeil === 7, "check-in du jour présent (sommeil=7)");

  const { data: planned } = await userClient.from("scheduled_sessions").select("*").eq("athlete_id", userId);
  check(planned && planned.length >= 4, `séances planifiées : ${planned?.length ?? 0} (attendu ≥4)`);

  const { data: clubs } = await userClient.from("clubs").select("*").eq("owner_id", userId);
  check(clubs && clubs.length === 1 && clubs[0].name === "Muret Goat Squad", "club « Muret Goat Squad » créé");

  console.log("\n5) ÉCRITURE — saveCheckin (simule le bouton Valider)");
  const { error: upErr } = await userClient.from("checkins")
    .upsert({ athlete_id: userId, date: today, sommeil: 9, fatigue: 2, motivation: 10, readiness: 90 },
            { onConflict: "athlete_id,date" });
  check(!upErr, "upsert check-in OK");
  const { data: ci2 } = await userClient.from("checkins").select("*").eq("athlete_id", userId).eq("date", today).single();
  check(ci2.sommeil === 9 && ci2.readiness === 90, "check-in bien mis à jour en base (sommeil=9, readiness=90)");

  console.log("\n6) ÉCRITURE — markSessionDone (simule validation séance)");
  const target = planned[0];
  const { error: mdErr } = await userClient.from("scheduled_sessions")
    .update({ done: true, rpe: 7 }).eq("id", target.id);
  check(!mdErr, "update done/rpe OK");
  const { data: done } = await userClient.from("scheduled_sessions").select("done,rpe").eq("id", target.id).single();
  check(done.done === true && done.rpe === 7, "séance marquée done=true, rpe=7 en base");

  console.log("\n7) RLS — un AUTRE utilisateur ne doit PAS voir ces données");
  const otherEmail = `e2e-intrus+${Date.now()}@pairform.test`;
  const { data: other } = await admin.auth.admin.createUser({ email: otherEmail, password, email_confirm: true });
  const { data: oSign } = await anon.auth.signInWithPassword({ email: otherEmail, password });
  const otherClient = createClient(URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${oSign.session.access_token}` } },
  });
  const { data: leaked } = await otherClient.from("records").select("*").eq("athlete_id", userId);
  check(leaked && leaked.length === 0, `isolation RLS : l'intrus voit ${leaked?.length ?? "?"} records (attendu 0)`);

  // nettoyage de l'intrus
  await admin.auth.admin.deleteUser(other.user.id);

} catch (e) {
  bad("Exception : " + (e.message || e));
} finally {
  if (userId) { await admin.auth.admin.deleteUser(userId).catch(() => {}); console.log("\n🧹 utilisateur de test supprimé (cascade)"); }
  console.log(`\n=== RÉSULTAT : ${pass} ✅  /  ${fail} ❌ ===`);
  process.exit(fail ? 1 : 0);
}
