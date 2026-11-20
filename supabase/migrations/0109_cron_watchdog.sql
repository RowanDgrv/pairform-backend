-- 0109 (20/11/2026) — Chien de garde des tâches automatiques.
--
-- Suite à la panne du 17→20/11 (crons en 401 pendant 3 jours sans que personne ne le voie) :
--  1. chaque tâche cron journalise son appel (cron_calls.request_id = id pg_net) pour qu'on
--     puisse relier la réponse HTTP réelle (net._http_response, gardée ~6 h) à la tâche ;
--  2. cron_health() liste les problèmes : réponse ≠ 2xx, délai dépassé, pas de réponse,
--     tâche qui ne tourne plus, rappel du matin / de la veille non parti alors qu'une séance
--     est prévue, résumé admin en attente ;
--  3. la fonction cron-watchdog (appelée chaque heure, SANS secret pour ne pas tomber avec
--     lui) envoie un mail aux admins si cron_health() n'est pas vide, puis un mail
--     « rétabli » quand tout redevient normal.

create table if not exists public.cron_calls (
  id          bigserial primary key,
  jobname     text not null,
  request_id  bigint,
  called_at   timestamptz not null default now()
);
create index if not exists cron_calls_job_time on public.cron_calls (jobname, called_at desc);
alter table public.cron_calls enable row level security;
revoke all on public.cron_calls from anon, authenticated, public;

create table if not exists public.watchdog_state (
  id              int primary key default 1 check (id = 1),
  last_alert_at   timestamptz,
  last_signature  text,
  last_ok_at      timestamptz
);
insert into public.watchdog_state (id) values (1) on conflict do nothing;
alter table public.watchdog_state enable row level security;
revoke all on public.watchdog_state from anon, authenticated, public;

-- Les commandes des tâches journalisent leur appel.
do $$
declare j record; fn text;
begin
  for j in select jobid, jobname, command from cron.job where command ilike '%x-cron-secret%' loop
    fn := substring(j.command from '/functions/v1/([a-z0-9-]+)');
    perform cron.alter_job(job_id := j.jobid, command := format(
      $cmd$insert into public.cron_calls (jobname, request_id) select %L, net.http_post(url:='https://onbsgohvqejccowfnrbs.supabase.co/functions/v1/%s', headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret', public.get_app_secret('cron_secret')), body:='{}'::jsonb, timeout_milliseconds:=30000);$cmd$,
      j.jobname, fn));
  end loop;
end $$;

create or replace function public.cron_health()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  probs text[] := '{}';
  j record;
  r record;
  last_call timestamptz;
  max_gap interval;
  n int;
begin
  delete from public.cron_calls where called_at < now() - interval '14 days';

  -- 1. chaque tâche : tourne-t-elle encore, et que répondent les fonctions ?
  for j in select jobname, active from cron.job where command ilike '%cron_calls%' order by jobname loop
    if not j.active then probs := probs || format('%s : tâche désactivée', j.jobname); continue; end if;
    max_gap := case when j.jobname = 'coros-poll' then interval '3 hours'
                    when j.jobname = 'sillance-cron-watchdog' then interval '2 hours'
                    else interval '1 hour' end;
    select max(called_at) into last_call from public.cron_calls where jobname = j.jobname;
    if last_call is null or last_call < now() - max_gap then
      probs := probs || format('%s : aucun appel depuis %s', j.jobname,
        coalesce(to_char(last_call at time zone 'Europe/Paris', 'DD/MM HH24:MI'), 'jamais'));
    end if;

    -- réponses en échec sur les 3 dernières heures
    select count(*) into n
      from public.cron_calls c join net._http_response h on h.id = c.request_id
     where c.jobname = j.jobname and c.called_at > now() - interval '3 hours'
       and (h.status_code is null or h.status_code not between 200 and 299);
    if n > 0 then
      probs := probs || format('%s : %s appel(s) en échec sur 3 h (dernier : %s)', j.jobname, n,
        (select coalesce(h.status_code::text, case when h.timed_out then 'délai dépassé' else left(h.error_msg, 60) end)
           from public.cron_calls c join net._http_response h on h.id = c.request_id
          where c.jobname = j.jobname and c.called_at > now() - interval '3 hours'
            and (h.status_code is null or h.status_code not between 200 and 299)
          order by c.called_at desc limit 1));
    end if;
  end loop;

  -- tâche dont l'exécution SQL elle-même échoue
  for r in select cj.jobname, count(*) n from cron.job_run_details d join cron.job cj using (jobid)
            where d.start_time > now() - interval '3 hours' and d.status = 'failed' group by 1 loop
    probs := probs || format('%s : exécution en échec %s fois sur 3 h', r.jobname, r.n);
  end loop;

  -- 2. rappel du matin non parti alors qu'une séance est prévue (45 min de marge)
  select count(*) into n
    from public.notification_prefs p
   where p.channel <> 'none' and not coalesce(p.eve_enabled, false)
     and (now() at time zone coalesce(p.tz, 'Europe/Paris'))::time > make_time(p.send_hour, p.send_minute, 0) + interval '45 minutes'
     and p.last_sent_on is distinct from (now() at time zone coalesce(p.tz, 'Europe/Paris'))::date
     and exists (select 1 from public.scheduled_sessions s
                  where s.athlete_id = p.user_id and not s.done
                    and s.date = (now() at time zone coalesce(p.tz, 'Europe/Paris'))::date);
  if n > 0 then probs := probs || format('mail du matin : %s athlète(s) avec séance aujourd''hui ne l''ont pas reçu', n); end if;

  -- rappel de la veille non parti alors qu'une séance est prévue demain
  select count(*) into n
    from public.notification_prefs p
   where p.channel <> 'none' and coalesce(p.eve_enabled, false)
     and (now() at time zone coalesce(p.tz, 'Europe/Paris'))::time > make_time(p.eve_hour, p.eve_minute, 0) + interval '45 minutes'
     and p.eve_last_sent_on is distinct from (now() at time zone coalesce(p.tz, 'Europe/Paris'))::date
     and exists (select 1 from public.scheduled_sessions s
                  where s.athlete_id = p.user_id and not s.done
                    and s.date = (now() at time zone coalesce(p.tz, 'Europe/Paris'))::date + 1);
  if n > 0 then probs := probs || format('rappel de la veille : %s athlète(s) avec séance demain ne l''ont pas reçu', n); end if;

  -- 3. résumé admin déposé mais jamais parti
  select count(*) into n from public.admin_digests where sent_at is null and created_at < now() - interval '1 hour';
  if n > 0 then probs := probs || format('admin-ops : %s résumé(s) admin en attente depuis plus d''1 h', n); end if;
  select count(*) into n from public.admin_digests where error is not null and sent_at > now() - interval '24 hours';
  if n > 0 then probs := probs || format('admin-ops : %s résumé(s) admin refusé(s) sur 24 h', n); end if;

  return jsonb_build_object('ok', cardinality(probs) = 0, 'checked_at', now(), 'problems', to_jsonb(probs));
end $$;

revoke all on function public.cron_health() from anon, authenticated, public;
grant execute on function public.cron_health() to service_role;

-- Chien de garde : chaque heure à :50, sans secret (il ne doit pas tomber avec lui).
select cron.unschedule('sillance-cron-watchdog') where exists (select 1 from cron.job where jobname = 'sillance-cron-watchdog');
select cron.schedule('sillance-cron-watchdog', '50 * * * *',
  $cmd$insert into public.cron_calls (jobname, request_id) select 'sillance-cron-watchdog', net.http_post(url:='https://onbsgohvqejccowfnrbs.supabase.co/functions/v1/cron-watchdog', headers:=jsonb_build_object('Content-Type','application/json'), body:='{}'::jsonb, timeout_milliseconds:=30000);$cmd$);

-- Point de départ : évite une fausse alerte « aucun appel » avant le premier passage de chaque tâche.
insert into public.cron_calls (jobname, request_id)
select jobname, null from cron.job
 where command ilike '%cron_calls%'
   and not exists (select 1 from public.cron_calls c where c.jobname = cron.job.jobname);
