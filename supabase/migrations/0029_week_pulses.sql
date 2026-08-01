-- Feedback hebdo bidirectionnel : ressenti + note de l'athlète sur sa semaine,
-- note du coach sur la même semaine, croisés dans une seule vue (calendrier).
create table if not exists week_pulses (
  id           uuid primary key default gen_random_uuid(),
  athlete_id   uuid not null references profiles(id) on delete cascade,
  week_monday  date not null,
  athlete_feel text,   -- 'hard' | 'ok' | 'easy'
  athlete_note text,
  coach_note   text,
  updated_at   timestamptz not null default now(),
  unique (athlete_id, week_monday)
);
alter table week_pulses enable row level security;
drop policy if exists "week_pulses: athlete manages own" on week_pulses;
create policy "week_pulses: athlete manages own" on week_pulses
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
drop policy if exists "week_pulses: coach manages" on week_pulses;
create policy "week_pulses: coach manages" on week_pulses
  for all using (is_coach_of(athlete_id)) with check (is_coach_of(athlete_id));
