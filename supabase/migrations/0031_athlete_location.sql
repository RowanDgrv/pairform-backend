-- Localisation de l'athlète (ville + coordonnées géocodées côté client via
-- l'API gratuite Open-Meteo, sans clé) — sert l'alerte météo → swap séance.
alter table athlete_profiles add column if not exists city text;
alter table athlete_profiles add column if not exists lat numeric;
alter table athlete_profiles add column if not exists lon numeric;
