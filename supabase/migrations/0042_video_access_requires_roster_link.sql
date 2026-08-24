-- =============================================================================
--  0042 — video_access : exige un vrai lien coach↔athlète actif
--  ---------------------------------------------------------------------------
--  Audit sécurité 23-24/08/2026 (point mineur) : la policy va_coach_all
--  (0011_video_access.sql) ne vérifiait que coach_id = auth.uid(), pas que
--  l'athlete_id ciblé fait bien partie du roster de ce coach. L'edge function
--  video-seats-set fait cette vérification (coach_athlete actif), mais un
--  appel direct au client (supabase.from('video_access').upsert(...)) la
--  contournait entièrement : un coach pouvait activer l'accès vidéo premium
--  pour un athlète hors de son roster. Impact limité (accès gratuit à du
--  contenu non sensible, pas une fuite de données), mais même contournement
--  de garde applicative qu'ailleurs — corrigé pour cohérence.
--
--  Constat au déploiement (24/08/2026) : la migration 0011_video_access.sql
--  est enregistrée comme appliquée en prod (supabase_migrations.schema_migrations)
--  mais les tables video_access/video_seats n'existent nulle part sur la base
--  live — dérive d'historique de migrations, cause exacte non déterminée.
--  Conséquence réelle : la fonctionnalité « sièges vidéo » a toujours renvoyé
--  une erreur 500 au premier clic du coach (video-seats-set), AVANT toute
--  création de session Stripe — donc aucun paiement n'a pu avoir lieu via ce
--  chemin. On rejoue ici le contenu (idempotent) de 0011 avant d'appliquer le
--  durcissement de policy, pour que 0042 soit autosuffisante.
-- =============================================================================
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

drop trigger if exists video_access_touch on video_access;
create trigger video_access_touch before update on video_access
  for each row execute function touch_updated_at();
drop trigger if exists video_seats_touch on video_seats;
create trigger video_seats_touch before update on video_seats
  for each row execute function touch_updated_at();

alter table video_access enable row level security;
alter table video_seats  enable row level security;

drop policy if exists va_athlete_read on video_access;
create policy va_athlete_read on video_access
  for select using (athlete_id = auth.uid());

drop policy if exists vs_coach_read on video_seats;
create policy vs_coach_read on video_seats
  for select using (coach_id = auth.uid());

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

drop policy if exists va_coach_all on video_access;
create policy va_coach_all on video_access
  for all
  using (coach_id = auth.uid() and is_coach_of(athlete_id))
  with check (coach_id = auth.uid() and is_coach_of(athlete_id));
