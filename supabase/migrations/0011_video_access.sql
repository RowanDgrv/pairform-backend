-- =============================================================================
--  0011_video_access.sql — Option « Vidéos » PAR ATHLÈTE (payée par le COACH)
--
--  Modèle (Phase 1, décidé 02/07/2026) : le coach débloque les vidéos
--  d'exercices athlète par athlète et paie un SIÈGE (seat) par athlète activé.
--  Facturation = 1 abonnement Sillance côté coach dont la QUANTITÉ = nombre
--  d'athlètes activés (produit Sillance, PAS de Connect). Le coach peut ensuite
--  refacturer plus cher son suivi via coach_offers.
--
--  - video_access : quels athlètes le coach a activés (toggle applicatif).
--  - video_seats  : l'état de facturation par coach (écrit par le webhook +
--                   la fonction video-seats-set via service_role). SOURCE DE
--                   VÉRITÉ du paiement = le webhook.
--  - athlete_has_videos() : l'athlète voit-il les vidéos ? (activé ET payé).
--
--  Idempotent (re-jouable) : drop policy if exists avant chaque create.
-- =============================================================================

-- Quels athlètes le coach a activés pour les vidéos ----------------------------
create table if not exists video_access (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references profiles(id) on delete cascade,
  athlete_id  uuid not null references profiles(id) on delete cascade,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (coach_id, athlete_id)
);
create index if not exists video_access_athlete_idx on video_access(athlete_id);

-- État de facturation « sièges vidéo » par coach (1 ligne / coach) -------------
create table if not exists video_seats (
  coach_id               uuid primary key references profiles(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  stripe_item_id         text,
  seats                  int not null default 0,
  status                 text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- updated_at auto (réutilise la fonction existante touch_updated_at) -----------
drop trigger if exists video_access_touch on video_access;
create trigger video_access_touch before update on video_access
  for each row execute function touch_updated_at();
drop trigger if exists video_seats_touch on video_seats;
create trigger video_seats_touch before update on video_seats
  for each row execute function touch_updated_at();

-- RLS --------------------------------------------------------------------------
alter table video_access enable row level security;
alter table video_seats  enable row level security;

-- Le coach gère (lit/écrit) ses propres activations.
drop policy if exists va_coach_all on video_access;
create policy va_coach_all on video_access
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
-- L'athlète peut lire s'il est activé (savoir s'il a droit aux vidéos).
drop policy if exists va_athlete_read on video_access;
create policy va_athlete_read on video_access
  for select using (athlete_id = auth.uid());

-- Le coach lit son état de facturation. L'ÉCRITURE passe uniquement par la
-- service_role (webhook + fonction) → aucune policy d'écriture = tout bloqué.
drop policy if exists vs_coach_read on video_seats;
create policy vs_coach_read on video_seats
  for select using (coach_id = auth.uid());

-- L'athlète connecté a-t-il accès aux vidéos ? (activé PAR un coach ET payé) ---
create or replace function athlete_has_videos()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from video_access va
    join video_seats  vs on vs.coach_id = va.coach_id
    where va.athlete_id = auth.uid()
      and va.active
      and vs.status in ('active', 'trialing')
  );
$$;
