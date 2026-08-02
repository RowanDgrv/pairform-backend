-- Mode spectateur : lien public (sans compte) partagé avec les proches
-- pendant une course. PAS de tracking GPS live (l'API Strava ne l'expose
-- pas) — juste les repères de course laissés par le coach/l'athlète, et le
-- résultat dès qu'il est disponible (réutilise race_debriefs si rempli).
-- Écriture directe autorisée (athlète ou l'un de ses coachs) : créer un
-- lien de partage pour ses propres données n'est pas une action sensible
-- comme l'était coach_athlete (pas d'usurpation possible). La LECTURE
-- publique par token passe uniquement par l'edge function spectator-view
-- (service_role) — aucune policy SELECT pour anon ici.
create table if not exists spectator_links (
  id           uuid primary key default gen_random_uuid(),
  athlete_id   uuid not null references profiles(id) on delete cascade,
  token        text not null unique default encode(gen_random_bytes(12), 'hex'),
  race_name    text not null,
  race_date    date not null,
  pacing_notes text,
  created_by   uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now()
);
create unique index if not exists uq_spectator_race on spectator_links(athlete_id, race_name, race_date);
create index if not exists idx_spectator_athlete on spectator_links(athlete_id);

alter table spectator_links enable row level security;
drop policy if exists "spectator_links: owner or coach manages" on spectator_links;
create policy "spectator_links: owner or coach manages" on spectator_links
  for all using (athlete_id = auth.uid() or is_coach_of(athlete_id))
  with check (athlete_id = auth.uid() or is_coach_of(athlete_id));
