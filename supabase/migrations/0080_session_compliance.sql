-- =============================================================================
--  0080 — Verdict « consigne respectée ? » par séance réalisée (29/10/2026)
--
--  Calculé par l'app du coach avec le moteur sillance-consigne.js (le même
--  que la fenêtre d'analyse : règles de code, pas d'IA), à partir des courbes
--  de la montre, puis stocké ici une fois pour toutes. coach-needs s'en sert
--  pour l'écran « Qui a besoin de toi » (séances non conformes / partielles)
--  et pour lister les séances réalisées qui n'ont pas encore de verdict.
--  verdict 'none' = séance sans cible exploitable (rien à juger).
-- =============================================================================
create table if not exists public.session_compliance (
  scheduled_session_id uuid primary key references public.scheduled_sessions(id) on delete cascade,
  athlete_id   uuid not null references public.profiles(id) on delete cascade,
  activity_id  uuid references public.external_activities(id) on delete set null,
  verdict      text not null check (verdict in ('validee', 'partielle', 'non_conforme', 'none')),
  summary      text,
  issues       jsonb not null default '[]'::jsonb,
  computed_at  timestamptz not null default now()
);
create index if not exists session_compliance_athlete_idx on public.session_compliance (athlete_id, computed_at);
alter table public.session_compliance enable row level security;
drop policy if exists "session_compliance: athlete or coach" on public.session_compliance;
create policy "session_compliance: athlete or coach" on public.session_compliance
  for all using (athlete_id = auth.uid() or is_coach_of(athlete_id))
  with check (athlete_id = auth.uid() or is_coach_of(athlete_id));
