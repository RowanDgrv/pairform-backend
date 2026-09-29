-- =============================================================================
--  0062_activity_dedup.sql
--  Dédoublonnage des activités entre plateformes (Rowan 29/09/2026) : une
--  séance qui remonte à la fois via Strava (relais de la montre) ET via la
--  synchro directe Coros/Polar/Garmin créait deux lignes external_activities
--  distinctes (pas de clé commune entre plateformes). Marquage doux — jamais
--  de suppression, la marque de la montre gagne toujours sur Strava (voir
--  _shared/activityDedup.ts, appelé après chaque import).
-- =============================================================================
alter table external_activities
  add column if not exists duplicate_of uuid references external_activities(id) on delete set null;
create index if not exists idx_extact_duplicate_of on external_activities(duplicate_of);
