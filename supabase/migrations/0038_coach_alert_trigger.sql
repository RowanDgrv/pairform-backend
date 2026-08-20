-- =============================================================================
--  0038 — Trigger DB : appelle coach-alert-on-checkin à chaque check-in
--  ---------------------------------------------------------------------------
--  Utilise pg_net (déjà activé sur les projets Supabase) pour un appel HTTP
--  asynchrone après chaque insert/update de checkins, sans bloquer l'écriture
--  du check-in de l'athlète (échec de l'alerte ≠ échec de la sauvegarde).
--
--  ⚠️ ÉTAPES MANUELLES (voir bloc de commentaire en bas du fichier) :
--  1. Déployer coach-alert-on-checkin SANS vérification JWT (même contrainte
--     que morning-digest, qui se protège elle-même via x-cron-secret) :
--       supabase functions deploy coach-alert-on-checkin --no-verify-jwt
--  2. Poser app.settings.cron_secret sur la base (une fois, hors migration
--     versionnée — voir commentaire en bas).
-- =============================================================================
-- pg_net n'est PAS relocalisable (son control file fixe schema='net') —
-- sur un projet Supabase il est presque toujours déjà activé dans ce
-- schéma par défaut. Préciser `with schema extensions` ici aurait échoué
-- si l'extension était déjà installée ailleurs, ou si elle est non
-- relocalisable (erreur trouvée en relecture du 06/08/2026, jamais
-- exécutée en pratique faute d'accès au projet Supabase réel).
create extension if not exists pg_net;

create or replace function notify_coach_on_checkin()
returns trigger as $$
begin
  perform net.http_post(
    url := 'https://onbsgohvqejccowfnrbs.supabase.co/functions/v1/coach-alert-on-checkin',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.settings.cron_secret', true)
    ),
    body := jsonb_build_object('checkin_id', new.id)
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_notify_coach_on_checkin on checkins;
create trigger trg_notify_coach_on_checkin
  after insert or update on checkins
  for each row execute function notify_coach_on_checkin();

-- Le trigger lit le secret CRON_SECRET via un paramètre de session Postgres
-- plutôt que de l'écrire en dur dans la fonction (visible par quiconque a
-- accès en lecture à pg_proc sinon). Poser la valeur une fois, dans le SQL
-- Editor du dashboard (PAS dans ce fichier de migration versionné) :
--
--   alter database postgres set app.settings.cron_secret = 'la_meme_valeur_que_le_secret_CRON_SECRET_des_edge_functions';
--
-- Sans ce réglage, current_setting(...) renvoie NULL, l'appel HTTP part avec
-- un en-tête x-cron-secret vide, et coach-alert-on-checkin répond 401 sans
-- jamais faire échouer l'insertion du check-in (l'erreur pg_net est
-- asynchrone, jamais remontée à l'athlète).
