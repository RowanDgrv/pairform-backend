-- 0108 (20/11/2026) — Les tâches cron lisent le secret dans app_secrets au moment de l'appel.
--
-- Panne constatée le 20/11 : le 17/11 (audit sécurité, 0105) cron_secret a été changé dans
-- app_secrets ET dans le secret CRON_SECRET des fonctions, mais les 5 tâches cron gardaient
-- l'ANCIENNE valeur écrite en dur dans leur commande → 401 « unauthorized » à chaque appel
-- depuis le 17/11 au soir : plus de mail du matin, de rappels coach, d'alertes de séances
-- manquées, de synchro COROS ni d'admin-ops.
--
-- Désormais la commande appelle get_app_secret('cron_secret') : un futur changement de secret
-- se fait à un seul endroit (app_secrets + CRON_SECRET des fonctions), sans toucher aux tâches.
-- Délai porté de 5 s (défaut pg_net) à 30 s pour que la réponse réelle soit journalisée.

do $$
declare
  j record;
  fn text;
begin
  for j in
    select jobid, jobname, command from cron.job where command ilike '%x-cron-secret%'
  loop
    fn := substring(j.command from '/functions/v1/([a-z0-9-]+)');
    perform cron.alter_job(
      job_id  := j.jobid,
      command := format(
        $cmd$select net.http_post(url:='https://onbsgohvqejccowfnrbs.supabase.co/functions/v1/%s', headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', public.get_app_secret('cron_secret')), body:='{}'::jsonb, timeout_milliseconds:=30000);$cmd$,
        fn)
    );
  end loop;
end $$;
