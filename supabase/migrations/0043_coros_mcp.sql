-- =============================================================================
--  0043 — COROS : bascule sur le serveur MCP self-service (OAuth 2.1 + DCR)
--  ---------------------------------------------------------------------------
--  COROS a fermé le "COROS Open API" partenaire au profit d'un serveur MCP
--  hébergé (https://mcpeu.coros.com/mcp) accessible SANS homologation :
--    • Enregistrement dynamique de client (RFC 7591) → pas de dossier.
--    • OAuth 2.1 authorization_code + PKCE S256 + refresh (scope offline_access).
--    • Lecture seule aujourd'hui (records, détail, .FIT, VFC, récup, charge).
--      L'écriture (generateTrainingPlan / updateTrainingPlan) = "coming soon"
--      côté COROS → le chemin "pousser une séance Sillance vers la montre" est
--      câblé mais inerte (voir _shared/corosMcp.ts::pushPlannedSession).
--
--  Cette migration :
--    1. ajoute device_connections.meta (jsonb) — y ranger l'openId COROS, le
--       dernier bilan wellness (VFC/récup/charge), etc.
--    2. crée integration_oauth_clients — le client_id renvoyé par le DCR est
--       persistant : on l'enregistre UNE fois puis on le réutilise (survit aux
--       redéploiements, gère la rotation).
--    3. étend la vue my_devices avec meta (données non sensibles : jamais de
--       jeton dedans) pour que le front affiche la carte "état de forme".
-- =============================================================================

-- ---------------------------------------------------------------------------
--  1. Colonne meta sur les connexions
-- ---------------------------------------------------------------------------
alter table device_connections
  add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column device_connections.meta is
  'Métadonnées non sensibles de la connexion (openId COROS, dernier bilan '
  'wellness, curseur de sync…). JAMAIS de jeton ici (colonnes access_token/'
  'refresh_token/token_secret dédiées, chiffrées).';

-- ---------------------------------------------------------------------------
--  2. Clients OAuth enregistrés dynamiquement (DCR)
--  Écrit / lu UNIQUEMENT par les edge functions (service_role). Aucune policy
--  → RLS active = personne d'autre n'y touche.
-- ---------------------------------------------------------------------------
create table if not exists integration_oauth_clients (
  provider        device_provider primary key,
  client_id       text not null,
  client_secret   text,                       -- null pour un client public (COROS : token_endpoint_auth_method=none)
  registration    jsonb,                       -- réponse brute du /connect/register
  registered_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table integration_oauth_clients enable row level security;

drop trigger if exists trg_touch_integration_oauth_clients on integration_oauth_clients;
create trigger trg_touch_integration_oauth_clients before update on integration_oauth_clients
  for each row execute function touch_updated_at();

comment on table integration_oauth_clients is
  'client_id/secret obtenus par enregistrement dynamique (RFC 7591) auprès du '
  'serveur d''autorisation d''un provider (COROS MCP). Persistant : enregistré '
  'une fois, réutilisé ensuite.';

-- ---------------------------------------------------------------------------
--  3. my_devices — ajoute meta (non sensible), garde les jetons masqués
-- ---------------------------------------------------------------------------
create or replace view my_devices
with (security_invoker = true) as
  select id, user_id, provider, provider_user_id, scope,
         (access_token is not null) as connected,
         meta,
         last_sync_at, created_at, updated_at
  from device_connections;

comment on view my_devices is
  'État des connexions d''objets connectés sans exposer les jetons OAuth '
  '(meta inclus : openId, bilan wellness — aucune donnée sensible).';
