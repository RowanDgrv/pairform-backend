-- Calendrier de saison + fiche de course (21/09/2026)
-- ---------------------------------------------------------------------------
-- Le calendrier de saison et la fiche de course ("Analyse de course", DA
-- Cockpit validée 18-20/09/2026) n'avaient jusqu'ici AUCUNE persistance
-- côté serveur : races/recap vivaient uniquement dans le ROSTER en mémoire
-- du navigateur (sillance-app.core.js). Conséquence réelle : tout disparaît
-- au rechargement, et le coach et l'athlète — pourtant censés voir la même
-- fiche — ne partagent en fait jamais rien. Cette table corrige ça.
--
-- `race_date` est une vraie date absolue (pas un offset "days" figé au
-- moment de la création comme côté front) : le nombre de jours restants se
-- recalcule à la volée à chaque affichage, il ne dérive plus avec le temps.
--
-- `recap` reprend tel quel le JSON déjà utilisé côté front (swim/bike/t1/
-- t2/splits/rank/cond/nutrition/segments/roxzone) — aucune raison de
-- l'éclater en colonnes, c'est un formulaire libre par type de course.
-- `recap.links` (ajouté par le front, pas par cette migration) y stocke les
-- {swim,bike,run: external_activities.id} de l'auto-liaison d'activités.
create table if not exists races (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  name        text not null,
  location    text,
  race_date   date not null,
  type        text not null default 'run' check (type in ('run','tri','hyrox')),
  priority    text not null default 'C' check (priority in ('A','B','C')),
  result      text,
  recap       jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_races_athlete_date on races(athlete_id, race_date);

alter table races enable row level security;

-- Comme scheduled_sessions/records : l'athlète est propriétaire, le coach
-- (lien actif via coach_athlete) a les mêmes droits pour saisir/corriger la
-- fiche depuis la fiche athlète — c'est un usage explicitement demandé
-- (Rowan, 21/09/2026), pas une fuite de droits.
create policy "races: athlete all" on races
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "races: coach manages" on races
  for all using (is_coach_of(athlete_id)) with check (is_coach_of(athlete_id));
