-- 0110 (20/11/2026) — Le chien de garde contrôle aussi le CONTENU de la synchro COROS.
--
-- coros-poll répond 200 même quand tous les athlètes échouent (il renvoie {ok, imported, failed}) :
-- un contrôle du seul code HTTP ne voit rien. Constaté au passage : la connexion d'un athlète
-- est morte depuis le 22/10 (accès expiré, renouvellement en échec) sans alerte.
--
-- coros_health() renvoie la liste des problèmes (sans nom ni e-mail : la réponse du chien de
-- garde est publique) :
--   a. dernier passage de coros-poll avec des athlètes en échec, ou 0 connexion traitée ;
--   b. connexion dont la synchro n'a pas abouti depuis plus de 5 h (2 passages ratés),
--      en précisant si l'accès COROS est expiré ;
--   c. activités importées sur 3 jours sans durée ou sans fichier .FIT ;
--   d. synchro qui tourne mais ne ramène plus rien : 0 activité sur 7 jours pour un athlète
--      qui en avait au moins 6 sur les 4 semaines d'avant ;
--   e. bilan forme (sommeil/VFC) non rafraîchi alors que la synchro des activités passe.

create or replace function public.coros_health()
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  probs text[] := '{}';
  body jsonb;
  n int; n_exp int; oldest timestamptz;
begin
  -- a. réponse du dernier passage de coros-poll (gardée ~6 h par pg_net)
  select h.content::jsonb into body
    from public.cron_calls c join net._http_response h on h.id = c.request_id
   where c.jobname = 'coros-poll' and h.status_code between 200 and 299
   order by c.called_at desc limit 1;
  if body is not null then
    if coalesce((body->>'failed')::int, 0) > 0 then
      probs := probs || format('COROS : %s athlète(s) sur %s en échec au dernier passage de coros-poll',
                               body->>'failed', body->>'total');
    end if;
    if coalesce((body->>'total')::int, 0) = 0
       and exists (select 1 from public.device_connections where provider = 'coros') then
      probs := probs || 'COROS : coros-poll n''a traité aucune connexion alors qu''il en existe';
    end if;
  end if;

  -- b. connexions dont la synchro n'aboutit plus
  select count(*), count(*) filter (where expires_at < now()), min(last_sync_at)
    into n, n_exp, oldest
    from public.device_connections
   where provider = 'coros' and (last_sync_at is null or last_sync_at < now() - interval '5 hours');
  if n > 0 then
    probs := probs || format('COROS : synchro arrêtée pour %s athlète(s) (la plus ancienne depuis le %s)%s',
      n, coalesce(to_char(oldest at time zone 'Europe/Paris', 'DD/MM HH24:MI'), 'jamais'),
      case when n_exp > 0 then format(', dont %s avec l''accès COROS expiré : renouvellement en échec, reconnexion à faire', n_exp) else '' end);
  end if;

  -- c. activités importées incomplètes
  select count(*) into n from public.external_activities
   where provider = 'coros' and imported_at between now() - interval '3 days' and now() - interval '3 hours'
     and (coalesce(duration_s, 0) = 0 or raw->>'fit_url' is null);
  if n > 0 then probs := probs || format('COROS : %s activité(s) importée(s) sur 3 jours sans durée ou sans fichier .FIT', n); end if;

  -- d. synchro qui passe mais ne ramène plus rien
  select count(*) into n
    from public.device_connections d
   where d.provider = 'coros' and d.last_sync_at > now() - interval '5 hours'
     and (select count(*) from public.external_activities e
           where e.user_id = d.user_id and e.provider = 'coros'
             and e.start_time between now() - interval '35 days' and now() - interval '7 days') >= 6
     and not exists (select 1 from public.external_activities e
           where e.user_id = d.user_id and e.provider = 'coros' and e.start_time > now() - interval '7 days');
  if n > 0 then probs := probs || format('COROS : aucune activité sur 7 jours pour %s athlète(s) habituellement actif(s) (synchro OK) : vérifier ce que renvoie COROS', n); end if;

  -- e. bilan forme non rafraîchi
  select count(*) into n
    from public.device_connections d
   where d.provider = 'coros' and d.last_sync_at > now() - interval '5 hours'
     and coalesce((d.meta->'wellness'->>'at')::timestamptz, 'epoch') < now() - interval '5 hours';
  if n > 0 then probs := probs || format('COROS : bilan forme (sommeil, VFC) non rafraîchi pour %s athlète(s)', n); end if;

  return probs;
end $$;

revoke all on function public.coros_health() from anon, authenticated, public;
grant execute on function public.coros_health() to service_role;

-- cron_health() (0109) appelle désormais coros_health().
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

  -- 4. contenu de la synchro COROS (0110)
  probs := probs || public.coros_health();

  return jsonb_build_object('ok', cardinality(probs) = 0, 'checked_at', now(), 'problems', to_jsonb(probs));
end $$;

revoke all on function public.cron_health() from anon, authenticated, public;
grant execute on function public.cron_health() to service_role;

revoke all on function public.cron_health() from anon, authenticated, public;
grant execute on function public.cron_health() to service_role;
