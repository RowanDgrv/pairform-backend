-- ---------------------------------------------------------------------------
--  0021 — Effort musculaire par séance (#3 retour coach)
--  Le RPE existant mesure le coût cardio/respiratoire ; l'effort musculaire
--  (jambes) est distinct (côtes, renfo, pliométrie = fort muscu, cardio modéré).
--  L'athlète le note à la validation de séance ; le coach le voit. Facultatif.
--  Le client (markSessionDone) l'envoie avec repli gracieux si absent.
-- ---------------------------------------------------------------------------
alter table scheduled_sessions
  add column if not exists rpe_muscle integer check (rpe_muscle between 1 and 10);
