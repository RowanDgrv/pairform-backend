-- =============================================================================
--  0064_week_review.sql
--  Assistant IA — synthèse HEBDOMADAIRE (demandé par Rowan, 07/10/2026) :
--  bouton sous le calendrier, lit les séances RÉALISÉES de la semaine affichée
--  et rend un verdict + recommandations pour la semaine suivante.
--
--  Même mécanique que session_summaries (0009_ai_addon.sql) :
--    - cache : un même (coach_id, athlete_id, week_key) ne rappelle Claude
--      qu'une fois (0 € API en relecture) — clic répété = même résultat lu
--      en base, jamais une 2e requête.
--    - gate : has_ai_addon(uid), DÉJÀ étendu (migration 0045) au coach de
--      club payant via clubs.premium_until → couvre nativement le cas
--      "coach de club avec supplément" demandé, sans rien ajouter ici.
-- =============================================================================

create table if not exists week_reviews (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references profiles(id) on delete cascade,
  athlete_id    uuid references profiles(id) on delete set null,
  week_key      text not null,           -- lundi ISO de la semaine, ex. '2026-10-05'
  sessions      jsonb not null,          -- le payload chiffré envoyé au modèle (liste des séances)
  verdict       text,                    -- oui | partiel | non
  headline      text,
  bullets       jsonb,
  recos         jsonb,
  model         text,
  created_at    timestamptz not null default now(),
  unique (coach_id, athlete_id, week_key)
);
create index if not exists idx_week_reviews_coach on week_reviews(coach_id);

alter table week_reviews enable row level security;

drop policy if exists week_reviews_coach_all on week_reviews;
create policy week_reviews_coach_all on week_reviews
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

drop policy if exists week_reviews_athlete_read on week_reviews;
create policy week_reviews_athlete_read on week_reviews
  for select using (athlete_id = auth.uid());
