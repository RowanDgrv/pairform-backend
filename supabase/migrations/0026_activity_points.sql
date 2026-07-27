-- Cache des séries temporelles (GPS/FC/allure/puissance point par point) pour
-- les activités importées via API (Strava). Rempli à la demande (pas à
-- l'import) par l'edge function strava-activity-streams, pour éviter de
-- multiplier les appels API sur des activités jamais ouvertes en analyse.
-- Forme = même shape que le parseur .FIT/.TCX/.GPX (sillance-fit.js) :
-- [{time,lat,lon,alt,distM,hr,cad,pw,spdMs,stepLen}, ...]
alter table external_activities add column if not exists points jsonb;
comment on column external_activities.points is
  'Série temporelle normalisée (forme sillance-fit.js), cache rempli à la demande pour les activités Strava.';
