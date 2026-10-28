-- =============================================================================
--  0079 — Cycles (programmes multi-semaines) persistés par coach (28/10/2026)
--
--  Les cycles ne vivaient qu'en mémoire (const CYCLES dans l'app) : un coach
--  qui construisait un programme de 4 semaines le perdait au rechargement.
--  plan = { "semaine-jour": [id de séance de bibliothèque, …] } tel que
--  construit par le constructeur de cycles ; les id pointent vers
--  sessions.id (bibliothèque du coach), 'lib_<code>' (bibliothèque Sillance)
--  ou les séances exemples de l'app.
-- =============================================================================
create table if not exists public.coach_cycles (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  name       text not null default '',
  weeks      smallint not null default 4 check (weeks between 1 and 52),
  plan       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists coach_cycles_owner_idx on public.coach_cycles (owner_id);
alter table public.coach_cycles enable row level security;
drop policy if exists "coach_cycles: owner all" on public.coach_cycles;
create policy "coach_cycles: owner all" on public.coach_cycles
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
