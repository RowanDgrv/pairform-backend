-- =============================================================================
--  0074 — Conservation des données IA conforme à la politique (28/10/2026)
--
--  Constat (revue RGPD) : session_summaries.bilan et week_reviews.sessions
--  contiennent des données de santé de l'athlète (FC, ressenti) mais leur
--  athlete_id était en ON DELETE SET NULL : à la suppression du compte
--  athlète, ces données restaient chez le coach, contrairement à la promesse
--  « suppression dans les 30 jours ». Désormais : supprimées avec le compte
--  de l'athlète (comme déjà avec celui du coach).
--  + purge automatique du journal ai_failures (0073) après 90 jours.
-- =============================================================================

alter table public.session_summaries drop constraint if exists session_summaries_athlete_id_fkey;
alter table public.session_summaries add constraint session_summaries_athlete_id_fkey
  foreign key (athlete_id) references public.profiles(id) on delete cascade;

alter table public.week_reviews drop constraint if exists week_reviews_athlete_id_fkey;
alter table public.week_reviews add constraint week_reviews_athlete_id_fkey
  foreign key (athlete_id) references public.profiles(id) on delete cascade;

-- Purge quotidienne (04:20 UTC) du journal des échecs IA au-delà de 90 jours.
select cron.unschedule('sillance-purge-ai-failures')
  where exists (select 1 from cron.job where jobname = 'sillance-purge-ai-failures');
select cron.schedule('sillance-purge-ai-failures', '20 4 * * *',
  $$delete from public.ai_failures where created_at < now() - interval '90 days'$$);
