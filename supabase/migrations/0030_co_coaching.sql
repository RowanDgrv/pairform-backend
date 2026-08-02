-- Co-coaching : plusieurs coachs par athlète (ex. coach vélo + coach course,
-- ou nutritionniste/data analyst + entraîneur principal). Décisions produit :
-- accès COMPLET pour tout coach lié (le rôle est juste une étiquette
-- d'affichage, pas un moteur de permissions) ; double consentement à l'ajout
-- (celui qui n'est PAS à l'origine de la demande doit valider — coach ↔
-- athlète). Le coach invité doit déjà avoir un compte Sillance (v1 : pas de
-- flux d'onboarding coach par email, contrairement aux athlètes).

-- Étiquette de rôle sur le lien existant (Principal / Vélo / Course / Nutrition…)
alter table coach_athlete add column if not exists role_label text;

-- Un coach voit tous les liens coach_athlete de ses athlètes (pas seulement
-- les siens) : nécessaire pour afficher "l'équipe" complète autour d'un
-- athlète. is_coach_of() est SECURITY DEFINER -> pas de récursion RLS.
drop policy if exists "coach_athlete: teammates read" on coach_athlete;
create policy "coach_athlete: teammates read" on coach_athlete
  for select using (is_coach_of(athlete_id));

-- ---------------------------------------------------------------------------
--  CO_COACH_REQUESTS — demande d'ajout d'un coach supplémentaire à un athlète.
--  Initiée par un coach existant OU par l'athlète ; validée par "l'autre
--  partie" (logique appliquée côté edge function, pas en RLS). Aucune
--  écriture cliente directe (même leçon que coach_athlete, migration 0014) :
--  tout passe par co-coach-request / co-coach-approve en service_role.
-- ---------------------------------------------------------------------------
create table if not exists co_coach_requests (
  id                 uuid primary key default gen_random_uuid(),
  athlete_id         uuid not null references profiles(id) on delete cascade,
  coach_email        text not null,
  coach_id           uuid references profiles(id) on delete cascade,   -- résolu si le compte existe déjà
  role_label         text,
  requested_by       uuid not null references profiles(id) on delete cascade,
  requested_by_role  text not null,             -- 'coach' | 'athlete'
  status             text not null default 'pending', -- pending | approved | declined | cancelled | expired
  approved_by        uuid references profiles(id) on delete cascade,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  expires_at         timestamptz not null default (now() + interval '14 days')
);
create index if not exists idx_ccr_athlete on co_coach_requests(athlete_id);
create index if not exists idx_ccr_coach on co_coach_requests(coach_id);
-- une seule demande PENDING par couple (athlète, email) à la fois
create unique index if not exists uq_co_coach_pending
  on co_coach_requests(athlete_id, lower(coach_email)) where status = 'pending';

alter table co_coach_requests enable row level security;
drop policy if exists "co_coach_requests: visible aux parties concernées" on co_coach_requests;
create policy "co_coach_requests: visible aux parties concernées" on co_coach_requests
  for select using (
    athlete_id = auth.uid()
    or requested_by = auth.uid()
    or coach_id = auth.uid()
    or is_coach_of(athlete_id)
  );
