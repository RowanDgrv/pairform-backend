-- =============================================================================
--  0040 — Mesure d'audience anonyme (bandeau cookies, catégorie "analytics")
--  ---------------------------------------------------------------------------
--  Aucune donnée personnelle stockée : pas d'IP, pas de user_id, pas
--  d'identifiant visiteur persistant (ni cookie ni localStorage côté
--  mesure elle-même — sillance-cookies.js gère le CONSENTEMENT séparément).
--  path = pathname seul (jamais la query string, qui peut porter des tokens
--  d'invitation/spectateur/créneau) ; referrer_host = host seul (jamais l'URL
--  complète). Écriture exclusivement via l'edge function track-pageview
--  (service_role) : aucune policy INSERT/SELECT côté client, RLS verrouillée
--  comme oauth_states/client_errors (voir 0005/0034).
-- =============================================================================
create table if not exists pageviews (
  id          bigint generated always as identity primary key,
  path        text not null,
  referrer_host text,
  lang        text,
  created_at  timestamptz not null default now()
);
alter table pageviews enable row level security;
-- Aucune policy : lecture/écriture réservées au service_role (dashboard SQL
-- Editor pour Rowan, edge function pour l'écriture).

create index if not exists pageviews_created_at_idx on pageviews (created_at);
create index if not exists pageviews_path_idx on pageviews (path);
