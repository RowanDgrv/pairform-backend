-- =============================================================================
--  0076 — Rapports complets de séance (Assistant IA, 28/10/2026)
--  Cache des rapports générés par session-report : un rapport par coach et
--  par séance (pas de double génération). Supprimés avec le compte du coach
--  OU de l'athlète (ils contiennent des données de santé de l'athlète),
--  conformément à la politique de confidentialité (3.4).
-- =============================================================================
create table if not exists public.session_reports (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references public.profiles(id) on delete cascade,
  athlete_id  uuid references public.profiles(id) on delete cascade,
  session_key text not null,
  report      jsonb not null,
  model       text,
  created_at  timestamptz not null default now(),
  unique (coach_id, session_key)
);
alter table public.session_reports enable row level security;
drop policy if exists "session_reports coach reads" on public.session_reports;
create policy "session_reports coach reads" on public.session_reports
  for select using (coach_id = auth.uid());
