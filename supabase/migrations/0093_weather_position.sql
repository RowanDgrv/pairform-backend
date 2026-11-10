-- =============================================================================
--  0093 : position approximative de l'athlète pour la météo du rappel du matin
--  10/11/2026. Jusqu'ici la position venait du départ de la dernière sortie
--  Strava : les athlètes sur COROS ou Garmin n'en avaient pas, et personne
--  n'avait donné d'accord explicite. Désormais l'athlète active la météo dans
--  « Rappel du matin » : son navigateur demande sa position, on n'en garde
--  qu'un arrondi à 0,1° (~10 km). Pas de position = pas de règle météo.
--  « Désactiver » remet les quatre colonnes à null.
-- =============================================================================
alter table notification_prefs
  add column if not exists weather_lat        numeric(4,1) check (weather_lat between -90 and 90),
  add column if not exists weather_lon        numeric(5,1) check (weather_lon between -180 and 180),
  add column if not exists weather_pos_at     timestamptz,
  add column if not exists weather_consent_at timestamptz;
