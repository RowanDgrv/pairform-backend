-- Débrief post-course structuré (résultat, ressenti, nutrition, météo,
-- ce qui a marché / coincé) — journal de course rempli par l'athlète,
-- lu par son coach en lecture seule (Fiche athlète).
create table if not exists race_debriefs (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  race_name   text not null,
  race_date   date not null,
  result      text,
  felt        text,
  nutrition   text,   -- 'oui' | 'partiel' | 'non'
  weather     text,
  good        text,
  bad         text,
  created_at  timestamptz not null default now(),
  unique (athlete_id, race_name, race_date)
);
alter table race_debriefs enable row level security;
drop policy if exists "race_debriefs: athlete all" on race_debriefs;
create policy "race_debriefs: athlete all" on race_debriefs
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
drop policy if exists "race_debriefs: coach reads" on race_debriefs;
create policy "race_debriefs: coach reads" on race_debriefs
  for select using (is_coach_of(athlete_id));
