-- =============================================================================
--  0052_activity_feeling_mood.sql (24/09/2026)
--  ---------------------------------------------------------------------------
--  Complète le flux ressenti+matériel (migration 0051) avec un 2e indicateur
--  distinct du RPE, sur le modèle de Nolio/iDO (recherché sur demande de
--  Rowan) : le RPE mesure l'EFFORT (objectif, 0-10, alimente la charge
--  d'entraînement), la "sensation" mesure le BIEN-ÊTRE ressenti pendant la
--  séance (subjectif, saisi en smileys, ne rentre dans aucun calcul de
--  charge) — deux questions différentes qu'un athlète peut répondre
--  différemment (ex. effort dur mais bonnes sensations, ou l'inverse).
-- =============================================================================
alter table external_activities add column if not exists feeling_mood smallint
  check (feeling_mood is null or feeling_mood between 1 and 5);
comment on column external_activities.feeling_mood is
  'Sensation ressentie pendant la séance, 1 (très mauvaise) à 5 (excellente) — '
  'saisie en smileys, distincte du RPE (effort). N''alimente aucun calcul de '
  'charge, purement subjectif (cf. Nolio "sensation" vs "perception de l''effort").';
