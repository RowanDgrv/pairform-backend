-- =============================================================================
--  0094 : ville choisie à la main pour la météo du rappel du matin (10/11/2026)
--  Un athlète qui alterne entre deux villes (Paris / Toulouse) choisit son lieu
--  dans « Météo du jour » au lieu de dépendre de la position de l'appareil.
--  weather_city : libellé affiché (« Toulouse, Occitanie »). weather_manual :
--  vrai si le lieu a été choisi à la main, auquel cas l'app ne le remplace plus
--  par la position de l'appareil à l'ouverture.
-- =============================================================================
alter table notification_prefs
  add column if not exists weather_city   text,
  add column if not exists weather_manual boolean not null default false;
