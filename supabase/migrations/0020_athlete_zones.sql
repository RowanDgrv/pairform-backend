-- ---------------------------------------------------------------------------
--  0020 — Zones de travail personnalisées par athlète (#5 retour coach)
--  Le COACH définit les zones d'un athlète (test lactate, ressenti terrain).
--  athlete_profiles ne convient pas : sa RLS n'autorise que l'athlète à écrire
--  son profil (le coach n'a que la lecture). On isole donc les zones dans une
--  table où le coach a le droit d'écriture (is_coach_of), l'athlète lisant et
--  pouvant ajuster les siennes.
--  Forme du JSON : { modelKey: [[nom, borneBasse, borneHaute], ...], ... }
--  (modelKey = ftp | pma | cp_bike | vma | cv | fc … ; bornes en % de la réf.)
-- ---------------------------------------------------------------------------
create table if not exists athlete_zones (
  athlete_id uuid primary key references profiles(id) on delete cascade,
  zones      jsonb not null default '{}'::jsonb,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

alter table athlete_zones enable row level security;

-- l'athlète lit et gère ses propres zones
create policy "athlete_zones: athlete self" on athlete_zones
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());

-- le coach lié gère les zones de ses athlètes (lecture + écriture)
create policy "athlete_zones: coach manages" on athlete_zones
  for all using (is_coach_of(athlete_id)) with check (is_coach_of(athlete_id));
