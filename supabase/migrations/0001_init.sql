-- =============================================================================
--  Sillance — Schéma initial (Supabase / Postgres)
--  Couvre les 3 rôles : coach (phase 1), athlète B2C (phase 3), club (phase 2).
--  Calé sur le modèle de données des fichiers HTML existants :
--    disciplines (swim/bike/run/strength/hyrox), séances + blocs JSON,
--    records, check-in (sommeil/fatigue/motivation), refs physio (FTP/PMA/VMA/CSS…),
--    vidéos, clubs / groupes / créneaux tarifés.
--  v1 : on privilégie "ça marche pour les 3 rôles", on raffinera après.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
--  ENUMS
-- ---------------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('coach','athlete','club_admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type discipline as enum ('swim','bike','run','strength','hyrox','tri');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sub_status as enum ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_kind as enum ('coach','athlete','club');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
--  PROFILES  (1 ligne par utilisateur authentifié)
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          user_role not null default 'athlete',
  full_name     text,
  email         text,
  avatar_url    text,
  stripe_customer_id text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Crée automatiquement un profil à l'inscription (trigger sur auth.users).
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'athlete')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
--  ATHLETE_PROFILES  (refs physiologiques — ATHLETE_REF dans l'app)
-- ---------------------------------------------------------------------------
create table if not exists athlete_profiles (
  user_id   uuid primary key references profiles(id) on delete cascade,
  -- vélo
  ftp       numeric,           -- W
  pma       numeric,           -- W
  cp_bike   numeric,           -- puissance critique W
  -- course
  vma       numeric,           -- km/h
  cv        numeric,           -- vitesse critique km/h
  seuil_run numeric,           -- allure seuil s/km
  -- natation
  css       numeric,           -- critical swim speed s/100m
  -- FC
  fc_max    numeric,
  fc_repos  numeric,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  COACH_ATHLETE  (la "paire" coach ↔ athlète)
-- ---------------------------------------------------------------------------
create table if not exists coach_athlete (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references profiles(id) on delete cascade,
  athlete_id  uuid not null references profiles(id) on delete cascade,
  status      text not null default 'active',   -- active | invited | archived
  created_at  timestamptz not null default now(),
  unique (coach_id, athlete_id)
);
create index if not exists idx_ca_coach   on coach_athlete(coach_id);
create index if not exists idx_ca_athlete on coach_athlete(athlete_id);

-- ---------------------------------------------------------------------------
--  SESSIONS  (modèles de séances réutilisables — bibliothèque coach)
--  blocks = structure builderState.blocks (échauffement / séries / récup) en JSON.
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  disc        discipline not null,
  title       text not null,
  dur         integer default 0,        -- minutes
  dist        numeric default 0,        -- km (0 si non pertinent)
  tss         integer default 0,
  zone        text,                     -- 'Z2', 'Z4'…
  active_refs text[] default '{}',      -- ['ftp','fc','rpe']
  blocks      jsonb default '[]'::jsonb,
  is_template boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_sessions_owner on sessions(owner_id);

-- ---------------------------------------------------------------------------
--  SCHEDULED_SESSIONS  (planning[date] = [séances] assignées à un athlète)
-- ---------------------------------------------------------------------------
create table if not exists scheduled_sessions (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  created_by  uuid references profiles(id) on delete set null, -- coach ou athlète
  source_session_id uuid references sessions(id) on delete set null,
  date        date not null,
  disc        discipline not null,
  title       text not null,
  dur         integer default 0,
  dist        numeric default 0,
  tss         integer default 0,
  zone        text,
  blocks      jsonb default '[]'::jsonb,
  done        boolean not null default false,
  rpe         integer,                  -- ressenti 1-10
  created_at  timestamptz not null default now()
);
create index if not exists idx_sched_athlete_date on scheduled_sessions(athlete_id, date);

-- ---------------------------------------------------------------------------
--  RECORDS  (records personnels — RECORDS dans l'app)
-- ---------------------------------------------------------------------------
create table if not exists records (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  label       text not null,            -- '10 km', 'Semi', 'FTP', 'PMA'…
  value       text not null,            -- '31:45', '310 W'
  is_new      boolean not null default false,
  recorded_at date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists idx_records_athlete on records(athlete_id);

-- ---------------------------------------------------------------------------
--  CHECKINS  (check-in matinal — sommeil / fatigue / motivation)
-- ---------------------------------------------------------------------------
create table if not exists checkins (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  date        date not null default current_date,
  sommeil     integer check (sommeil between 1 and 10),
  fatigue     integer check (fatigue between 1 and 10),
  motivation  integer check (motivation between 1 and 10),
  readiness   integer,                  -- score % calculé côté app
  created_at  timestamptz not null default now(),
  unique (athlete_id, date)
);
create index if not exists idx_checkins_athlete_date on checkins(athlete_id, date);

-- ---------------------------------------------------------------------------
--  VIDEOS  (bibliothèque technique — VIDEOS dans l'app, brique B2C phase 3)
--  is_premium = réservé aux abonnés payants.
-- ---------------------------------------------------------------------------
create table if not exists videos (
  id          uuid primary key default gen_random_uuid(),
  disc        discipline not null,
  title       text not null,
  duration    text,                     -- '1:24'
  level       text,                     -- 'Débutant' | 'Inter' | 'Avancé'
  description text,
  tags        text[] default '{}',
  src         text,                     -- URL Storage / externe
  is_premium  boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  CLUBS / GROUPES / CRÉNEAUX  (phase 2)
-- ---------------------------------------------------------------------------
create table if not exists clubs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,            -- 'Muret Goat Squad'
  owner_id    uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists idx_clubs_owner on clubs(owner_id);

create table if not exists club_groups (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id) on delete cascade,
  name        text not null,            -- 'Hyrox', 'Adultes Triathlon Half'…
  color       text,
  description  text
);
create index if not exists idx_groups_club on club_groups(club_id);

create table if not exists club_members (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id) on delete cascade,
  athlete_id  uuid references profiles(id) on delete set null, -- null = membre non-inscrit
  display_name text,                    -- pour les membres sans compte
  disc        discipline,
  since        text,
  group_id    uuid references club_groups(id) on delete set null,
  role        text not null default 'member',  -- member | coach | admin
  created_at  timestamptz not null default now()
);
create index if not exists idx_members_club on club_members(club_id);

create table if not exists creneaux (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id) on delete cascade,
  disc        discipline not null,
  title       text not null,
  day         integer,                  -- 1=Lundi … 7=Dimanche
  time        text,                     -- '18:30'
  dur         integer,
  place       text,
  cap         integer,                  -- capacité
  coach       text,
  price       numeric not null default 0,  -- 0 = inclus dans l'adhésion ; >0 = à la carte
  group_id    uuid references club_groups(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_creneaux_club on creneaux(club_id);

create table if not exists creneau_attendees (
  creneau_id  uuid not null references creneaux(id) on delete cascade,
  athlete_id  uuid not null references club_members(id) on delete cascade,
  paid        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (creneau_id, athlete_id)
);

-- ---------------------------------------------------------------------------
--  SUBSCRIPTIONS  (état Stripe — la source de vérité, alimentée par le webhook)
-- ---------------------------------------------------------------------------
create table if not exists subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references profiles(id) on delete cascade,
  plan                   plan_kind not null,        -- coach | athlete | club
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  price_id               text,
  status                 sub_status not null default 'incomplete',
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now()
);
create index if not exists idx_subs_user on subscriptions(user_id);

-- Vue pratique : un utilisateur a-t-il un abonnement actif ?
create or replace view active_subscriptions as
  select * from subscriptions
  where status in ('trialing','active');

-- =============================================================================
--  HELPERS RLS  (security definer — contournent la RLS pour faire les jointures)
-- =============================================================================
create or replace function is_coach_of(target_athlete uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from coach_athlete
    where coach_id = auth.uid() and athlete_id = target_athlete and status = 'active'
  );
$$;

create or replace function owns_club(target_club uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from clubs where id = target_club and owner_id = auth.uid());
$$;

create or replace function is_club_member(target_club uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from club_members where club_id = target_club and athlete_id = auth.uid()
  );
$$;

-- =============================================================================
--  ROW LEVEL SECURITY
-- =============================================================================
alter table profiles            enable row level security;
alter table athlete_profiles    enable row level security;
alter table coach_athlete       enable row level security;
alter table sessions            enable row level security;
alter table scheduled_sessions  enable row level security;
alter table records             enable row level security;
alter table checkins            enable row level security;
alter table videos              enable row level security;
alter table clubs               enable row level security;
alter table club_groups         enable row level security;
alter table club_members        enable row level security;
alter table creneaux            enable row level security;
alter table creneau_attendees   enable row level security;
alter table subscriptions       enable row level security;

-- ---- PROFILES ----
create policy "profiles: self read"   on profiles for select using (id = auth.uid());
create policy "profiles: coach reads athletes" on profiles for select using (is_coach_of(id));
create policy "profiles: self update" on profiles for update using (id = auth.uid());

-- ---- ATHLETE_PROFILES ----
create policy "athlete_profiles: self all" on athlete_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "athlete_profiles: coach reads" on athlete_profiles
  for select using (is_coach_of(user_id));

-- ---- COACH_ATHLETE ----
create policy "coach_athlete: coach manages" on coach_athlete
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
create policy "coach_athlete: athlete reads" on coach_athlete
  for select using (athlete_id = auth.uid());

-- ---- SESSIONS (templates) ----
create policy "sessions: owner all" on sessions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---- SCHEDULED_SESSIONS ----
create policy "sched: athlete reads own" on scheduled_sessions
  for select using (athlete_id = auth.uid());
create policy "sched: athlete updates own (done/rpe)" on scheduled_sessions
  for update using (athlete_id = auth.uid());
create policy "sched: coach manages athlete plan" on scheduled_sessions
  for all using (is_coach_of(athlete_id)) with check (is_coach_of(athlete_id));

-- ---- RECORDS ----
create policy "records: athlete all" on records
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "records: coach reads" on records
  for select using (is_coach_of(athlete_id));

-- ---- CHECKINS ----
create policy "checkins: athlete all" on checkins
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "checkins: coach reads" on checkins
  for select using (is_coach_of(athlete_id));

-- ---- VIDEOS (catalogue) ----
-- Tout le monde voit les vidéos gratuites ; le premium est filtré côté app/edge
-- selon l'abonnement (lecture du catalogue OK, l'URL src reste protégée par Storage).
create policy "videos: read for authenticated" on videos
  for select to authenticated using (true);

-- ---- CLUBS ----
create policy "clubs: owner all" on clubs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "clubs: member reads" on clubs
  for select using (is_club_member(id));

-- ---- CLUB_GROUPS ----
create policy "club_groups: owner all" on club_groups
  for all using (owns_club(club_id)) with check (owns_club(club_id));
create policy "club_groups: member reads" on club_groups
  for select using (is_club_member(club_id));

-- ---- CLUB_MEMBERS ----
create policy "club_members: owner all" on club_members
  for all using (owns_club(club_id)) with check (owns_club(club_id));
create policy "club_members: self reads" on club_members
  for select using (athlete_id = auth.uid());

-- ---- CRENEAUX ----
create policy "creneaux: owner all" on creneaux
  for all using (owns_club(club_id)) with check (owns_club(club_id));
create policy "creneaux: member reads" on creneaux
  for select using (is_club_member(club_id));

-- ---- CRENEAU_ATTENDEES ----
create policy "attendees: club owner all" on creneau_attendees
  for all using (exists (
    select 1 from creneaux c where c.id = creneau_id and owns_club(c.club_id)
  ));

-- ---- SUBSCRIPTIONS (lecture seule côté client ; écriture = service_role/webhook) ----
create policy "subscriptions: self read" on subscriptions
  for select using (user_id = auth.uid());
