-- =============================================================================
-- 0105 — FAILLE CRITIQUE : get_app_secret lisible par tout le monde (17/11/2026)
--
-- get_app_secret(k) est SECURITY DEFINER et était exécutable par anon et
-- authenticated. N'importe qui, sans compte, pouvait lire app_secrets.cron_secret
-- via l'API publique (POST /rest/v1/rpc/get_app_secret {"k":"cron_secret"}) et
-- déclencher les tâches protégées par ce secret : morning-digest (mails à tous),
-- coach-week-reminder, coach-missed-alert, coros-poll, admin-ops,
-- coach-alert-on-checkin.
-- Seules les tâches pg_cron (rôle postgres, propriétaire) en ont besoin →
-- exécution retirée à tous les autres rôles.
-- À faire ensuite : CHANGER le secret (app_secrets.cron_secret ET le secret
-- CRON_SECRET des fonctions, à la même valeur), car il a pu être lu.
--
-- Appliquer : npx supabase db query --linked -f <ce fichier>   (JAMAIS db push)
-- =============================================================================
revoke execute on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;
