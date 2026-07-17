-- ---------------------------------------------------------------------------
--  0023 — Cycle menstruel dans le check-in (physio féminine)
--  Suivi OPT-IN par l'athlète : phase du cycle (règles/folliculaire/ovulation/
--  lutéale) + jour du cycle, pour que le coach adapte l'entraînement au bon
--  moment. Donnée de SANTÉ art.9 RGPD, particulièrement sensible : couverte par
--  le consentement données de santé déjà exigé ; l'athlète l'active et peut le
--  masquer à tout moment. Le client envoie ces colonnes avec repli gracieux.
-- ---------------------------------------------------------------------------
alter table checkins
  add column if not exists cycle_phase text check (cycle_phase in ('menstrual','follicular','ovulation','luteal')),
  add column if not exists cycle_day   integer check (cycle_day between 1 and 40);
