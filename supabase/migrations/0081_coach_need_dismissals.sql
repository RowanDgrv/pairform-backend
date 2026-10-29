-- =============================================================================
--  0081 — « Traité » de l'écran « Qui a besoin de toi » (29/10/2026)
--
--  Avant : mémorisé dans le navigateur (localStorage), donc perdu d'un
--  appareil à l'autre. need_key = athlete_id|type|événement (ex. première
--  séance d'une série manquée) : un NOUVEL événement a une autre clé et
--  réapparaît. Purge des marques de plus de 60 jours (les événements sont
--  calculés sur 3 semaines au plus).
-- =============================================================================
create table if not exists public.coach_need_dismissals (
  coach_id   uuid not null references public.profiles(id) on delete cascade,
  need_key   text not null check (length(need_key) <= 200),
  created_at timestamptz not null default now(),
  primary key (coach_id, need_key)
);
alter table public.coach_need_dismissals enable row level security;
drop policy if exists "coach_need_dismissals: own" on public.coach_need_dismissals;
create policy "coach_need_dismissals: own" on public.coach_need_dismissals
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

select cron.unschedule(jobid) from cron.job where jobname = 'sillance-purge-need-dismissals';
select cron.schedule('sillance-purge-need-dismissals', '40 4 * * *',
  $$delete from public.coach_need_dismissals where created_at < now() - interval '60 days'$$);
