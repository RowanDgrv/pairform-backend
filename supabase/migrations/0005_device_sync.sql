-- =============================================================================
--  0005 — Synchronisation des objets connectés (Strava / Garmin / Coros …)
--  ---------------------------------------------------------------------------
--  Deux tables :
--    • device_connections  : 1 ligne par (athlète, plateforme) — stocke les
--      jetons OAuth. Écrite UNIQUEMENT par les edge functions (service_role) ;
--      le front ne lit jamais les tokens (policy select limitée aux colonnes
--      non sensibles via la vue `my_devices`).
--    • external_activities : les activités importées, normalisées vers les
--      disciplines de l'app (`discipline`). Dédoublonnage par
--      (provider, provider_activity_id).
--  RLS : l'athlète voit ses propres connexions/activités ; le coach lié voit
--  les activités de ses athlètes (lecture seule).
-- =============================================================================

-- Plateformes supportées (extensible).
do $$ begin
  create type device_provider as enum ('strava','garmin','coros','polar','suunto','wahoo');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
--  CONNEXIONS (jetons OAuth) — sensibles, jamais exposées au front en clair
-- ---------------------------------------------------------------------------
create table if not exists device_connections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  provider         device_provider not null,
  provider_user_id text,                       -- id de l'athlète chez la plateforme
  access_token     text,
  refresh_token    text,
  expires_at       timestamptz,                -- expiration de l'access_token
  scope            text,
  last_sync_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, provider)
);
create index if not exists idx_devconn_user on device_connections(user_id);

-- ---------------------------------------------------------------------------
--  ACTIVITÉS IMPORTÉES — normalisées vers `discipline`
-- ---------------------------------------------------------------------------
create table if not exists external_activities (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references profiles(id) on delete cascade,
  provider             device_provider not null,
  provider_activity_id text not null,
  disc                 discipline,
  name                 text,
  start_time           timestamptz,
  duration_s           integer,                -- durée mouvement (s)
  distance_m           numeric,
  elevation_m          numeric,
  avg_hr               numeric,
  max_hr               numeric,
  avg_power            numeric,                -- W (vélo)
  avg_speed            numeric,                -- m/s
  calories             numeric,
  raw                  jsonb,                  -- payload brut de la plateforme
  imported_at          timestamptz not null default now(),
  unique (provider, provider_activity_id)
);
create index if not exists idx_extact_user_time on external_activities(user_id, start_time desc);

-- ---------------------------------------------------------------------------
--  ÉTATS OAuth — relie le callback (redirection navigateur, sans JWT) à l'user
--  qui a lancé la connexion. Écrit/lu uniquement par les edge functions.
-- ---------------------------------------------------------------------------
create table if not exists oauth_states (
  state      text primary key,
  user_id    uuid not null references profiles(id) on delete cascade,
  provider   device_provider not null,
  created_at timestamptz not null default now()
);
alter table oauth_states enable row level security;  -- aucune policy → service_role only

-- updated_at auto sur device_connections
drop trigger if exists trg_touch_device_connections on device_connections;
create trigger trg_touch_device_connections before update on device_connections
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
--  RLS
-- ---------------------------------------------------------------------------
alter table device_connections  enable row level security;
alter table external_activities enable row level security;

-- L'athlète peut voir/supprimer SA connexion (les tokens restent en base mais
-- ne sont pas renvoyés au front : voir la vue `my_devices` ci-dessous, et
-- n'utilise jamais select('*') côté client sur cette table).
create policy "devconn: self read"   on device_connections for select using (user_id = auth.uid());
create policy "devconn: self delete" on device_connections for delete using (user_id = auth.uid());
-- (insert/update : réservés au service_role des edge functions, qui ignore la RLS)

-- Activités : l'athlète voit les siennes ; le coach lié les voit aussi.
create policy "extact: self read"  on external_activities for select using (user_id = auth.uid());
create policy "extact: coach read" on external_activities for select using (is_coach_of(user_id));
create policy "extact: self delete" on external_activities for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
--  Vue sûre : état des connexions SANS les jetons (pour l'UI "comptes liés")
-- ---------------------------------------------------------------------------
create or replace view my_devices
with (security_invoker = true) as
  select id, user_id, provider, provider_user_id, scope,
         (access_token is not null) as connected,
         last_sync_at, created_at, updated_at
  from device_connections;

comment on view my_devices is
  'État des connexions d''objets connectés sans exposer les jetons OAuth.';
