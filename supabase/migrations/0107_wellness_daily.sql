-- =============================================================================
--  0107 — Santé mesurée par la montre, jour par jour (19/11/2026)
--
--  Sommeil (score, durée, phases), HRV de nuit (moyenne, plage normale, base)
--  et FC de repos, tirés de COROS par coros-poll / device-sync. Séparé des
--  check-ins : le check-in = ressenti de l'athlète, ici = mesure de la montre.
--  Date = jour du réveil (convention COROS : la nuit du 18 au 19 → 19).
--  Écriture : service role uniquement (fonctions). Lecture : l'athlète ou son coach.
-- =============================================================================
create table if not exists public.wellness_daily (
  athlete_id    uuid not null references public.profiles(id) on delete cascade,
  date          date not null,
  source        text not null default 'coros',
  sleep_score   smallint check (sleep_score between 0 and 100),
  sleep_min     smallint check (sleep_min between 0 and 1440),
  deep_pct      smallint check (deep_pct between 0 and 100),
  rem_pct       smallint check (rem_pct between 0 and 100),
  awake_min     smallint check (awake_min between 0 and 1440),
  hrv_ms        smallint check (hrv_ms between 5 and 300),
  hrv_low       smallint check (hrv_low between 0 and 300),
  hrv_high      smallint check (hrv_high between 0 and 300),
  hrv_baseline  smallint check (hrv_baseline between 0 and 300),
  hrv_eval      text check (char_length(hrv_eval) <= 40),
  resting_hr    smallint check (resting_hr between 20 and 140),
  updated_at    timestamptz not null default now(),
  primary key (athlete_id, date, source)
);
create index if not exists wellness_daily_athlete_date on public.wellness_daily (athlete_id, date);
alter table public.wellness_daily enable row level security;
drop policy if exists "wellness_daily: athlete or coach reads" on public.wellness_daily;
create policy "wellness_daily: athlete or coach reads" on public.wellness_daily
  for select using (athlete_id = auth.uid() or is_coach_of(athlete_id));
