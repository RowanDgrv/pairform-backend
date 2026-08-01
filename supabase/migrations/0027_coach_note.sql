-- Note du coach sur une séance planifiée précise (traçabilité d'un ajustement :
-- décalage, allègement, changement de contenu…), visible par l'athlète dans
-- sa fiche séance. Distincte des consignes par intervalle (déjà portées par
-- scheduled_sessions.blocks JSONB) : celle-ci est au niveau de la séance entière.
-- RLS : couverte par la policy existante "sched: coach manages athlete plan"
-- (FOR ALL using is_coach_of(athlete_id)) — aucune nouvelle policy nécessaire.
alter table scheduled_sessions add column if not exists coach_note text;
