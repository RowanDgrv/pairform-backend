-- =============================================================================
--  0010_strava_tos.sql  —  CONFORMITÉ aux conditions Strava (MAJ nov. 2024)
--  -----------------------------------------------------------------------------
--  L'API Strava INTERDIT de montrer les données d'un athlète à un tiers (son
--  coach). Or la policy "extact: coach read" (0005) laissait le coach lire TOUTES
--  les activités de l'athlète, y compris celles d'origine Strava → non conforme.
--
--  Correctif (le garde-fou est ici, au niveau base, pas seulement dans l'UI) :
--    • le coach ne peut PLUS lire les activités dont provider = 'strava' ;
--    • Garmin / Coros / upload de fichier (.FIT/.TCX/.GPX) restent partageables
--      avec le coach — ce sont les canaux autorisés pour le cas d'usage coaching.
--  L'athlète, lui, voit toujours TOUTES ses activités (Strava inclus, pour son
--  usage perso) via la policy "extact: self read" inchangée.
-- =============================================================================

-- Nouveau canal : fichiers importés manuellement (Garmin/Coros/montre → .FIT/.TCX/.GPX).
-- Distinct de 'strava' → visible par le coach. (PG15 : ADD VALUE hors usage immédiat = OK)
alter type device_provider add value if not exists 'upload';

-- Restreint la lecture coach : tout SAUF Strava.
drop policy if exists "extact: coach read" on external_activities;
create policy "extact: coach read" on external_activities
  for select using (is_coach_of(user_id) and provider <> 'strava');
