-- ---------------------------------------------------------------------------
--  0022 — HRV du matin dans le check-in (#2 retour coach, tranche saisie manuelle)
--  Variabilité de fréquence cardiaque (rMSSD, ms) saisie le matin (montre/
--  bracelet Whoop/Oura ou à la main). Donnée de SANTÉ art.9 RGPD : couverte
--  par le consentement données de santé déjà exigé à l'inscription (FC/check-ins).
--  L'auto-synchro depuis un appareil + le consentement par source restent à
--  faire (OAuth Garmin/Coros/Whoop). Le client envoie hrv avec repli gracieux.
-- ---------------------------------------------------------------------------
alter table checkins
  add column if not exists hrv integer check (hrv between 5 and 250);
