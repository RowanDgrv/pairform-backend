-- =============================================================================
--  0097 : nutrition des séances (12/11/2026)
--  - scheduled_sessions.nutrition : consignes { pre, during, post } écrites par
--    le coach (ou proposées par l'assistant IA puis validées par lui). Elles
--    n'étaient jusqu'ici PAS enregistrées : après rechargement, l'athlète
--    voyait un texte générique calculé à la volée.
--  - profiles.show_nutrition : réglage du coach « afficher les recommandations
--    nutrition à mes athlètes ». Faux = rien n'apparaît chez l'athlète ni dans
--    son rappel du matin, pour les séances que ce coach a créées.
-- =============================================================================
alter table scheduled_sessions add column if not exists nutrition jsonb;
alter table profiles add column if not exists show_nutrition boolean not null default true;
