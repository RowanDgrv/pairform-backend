-- =============================================================================
--  0046 — COROS : réception du push de données quotidiennes (API Reference
--  V2.1.1, section 5.5 "Daily Data Push" — mail COROS Partner Dev du 11/09/2026)
--  ---------------------------------------------------------------------------
--  Ce chemin est DISTINCT du MCP self-service (0043_coros_mcp.sql) :
--    • MCP           = OAuth 2.1 + PKCE par athlète, lecture via requêtes en
--                       langage naturel, pas de push, tiré par coros-poll.
--    • Daily Data Push = ancien "COROS Open API" partenaire. COROS pousse en
--                       HTTPS POST le sommeil/FC repos/VFC/pas/calories des 3
--                       derniers jours de chaque utilisateur, avec un couple
--                       client/secret STATIQUE attribué une fois à Sillance
--                       (pas par athlète). Voir _shared/corosPush.ts.
--  Les deux peuvent coexister : le push, une fois activé, remplace
--  avantageusement le parsing regex du texte MCP pour ces champs (voir
--  fetchWellness dans corosMcp.ts), mais rien ne l'exige.
-- =============================================================================

-- ---------------------------------------------------------------------------
--  1. Identifiants du push partenaire (attribués par COROS après activation,
--     PAS liés à un athlète — un seul couple pour tout Sillance).
--     Différent de integration_oauth_clients (0043) qui sert le DCR par
--     athlète du serveur MCP : mélanger les deux romprait l'auth MCP.
-- ---------------------------------------------------------------------------
create table if not exists partner_push_credentials (
  provider        device_provider primary key,
  client_id       text not null,
  client_secret   text not null,               -- chiffré applicativement (encryptToken)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table partner_push_credentials enable row level security;
-- Aucune policy → accessible uniquement au service_role des edge functions.

drop trigger if exists trg_touch_partner_push_credentials on partner_push_credentials;
create trigger trg_touch_partner_push_credentials before update on partner_push_credentials
  for each row execute function touch_updated_at();

comment on table partner_push_credentials is
  'Couple client_id/client_secret STATIQUE attribué par un partenaire (COROS) '
  'pour vérifier ses pushs serveur-à-serveur (5.5 Daily Data Push, 5.3 Workout '
  'Summary Push…). Un seul par provider, indépendant des comptes athlètes.';

-- ---------------------------------------------------------------------------
--  2. Données quotidiennes de santé poussées par le device (sommeil, FC repos,
--     VFC, pas, calories). Une ligne par (athlète, provider, jour).
-- ---------------------------------------------------------------------------
create table if not exists device_daily_metrics (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references profiles(id) on delete cascade,  -- null si openId pas encore lié
  provider         device_provider not null,
  provider_open_id text not null,               -- openId COROS (ou équivalent autre provider)
  day              date not null,               -- happenDay (yyyyMMdd → date)
  sleep_start      timestamptz,
  sleep_end        timestamptz,
  calories         numeric,
  steps            integer,
  resting_hr       integer,
  hrv_avg          integer,                     -- ppgHrv (VFC nocturne moyenne)
  sleep_avg_hr     integer,
  raw              jsonb not null default '{}'::jsonb,  -- payload brut (hrvList inclus)
  received_at      timestamptz not null default now(),
  unique (provider, provider_open_id, day)
);
create index if not exists idx_devdaily_user_day on device_daily_metrics(user_id, day desc);

alter table device_daily_metrics enable row level security;
create policy "devdaily: self read"  on device_daily_metrics for select using (user_id = auth.uid());
create policy "devdaily: coach read" on device_daily_metrics for select using (user_id is not null and is_coach_of(user_id));
-- Écriture réservée au service_role (edge function coros-daily-push).

comment on table device_daily_metrics is
  'Sommeil/FC repos/VFC/pas/calories poussés par un device (COROS Daily Data '
  'Push §5.5 et équivalents futurs). user_id peut être null tant que l''openId '
  'du payload ne correspond à aucune device_connections.provider_user_id '
  'connue (l''athlète peut se connecter après coup ; la ligne est alors '
  'orpheline mais jamais perdue — un job de rattachement pourra la relier).';
