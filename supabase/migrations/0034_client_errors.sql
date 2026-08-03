-- Télémétrie d'erreur front minimale (constat critique audit 03/08/2026 :
-- zéro visibilité en prod sur ce qui casse réellement pour un utilisateur
-- réel). Pas de SDK tiers (Sentry etc.) — table d'ingestion simple, écriture
-- seule pour les rôles publics, lecture réservée au service_role (Rowan
-- interroge directement via SQL Editor / service key, pas d'exposition
-- d'erreurs d'un utilisateur aux autres).
create table if not exists client_errors (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    uuid references profiles(id) on delete set null,
  message    text not null check (char_length(message) <= 2000),
  stack      text check (char_length(stack) <= 8000),
  url        text check (char_length(url) <= 500),
  user_agent text check (char_length(user_agent) <= 300),
  context    jsonb
);
create index if not exists idx_client_errors_created on client_errors(created_at desc);

alter table client_errors enable row level security;
-- INSERT seule, ouverte à anon (demo publique) et authenticated ; user_id doit
-- être soit vide soit celui de l'appelant (pas d'usurpation possible même si
-- une valeur arbitraire est postée).
drop policy if exists "client_errors: anyone inserts own" on client_errors;
create policy "client_errors: anyone inserts own" on client_errors
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
-- Aucune policy SELECT/UPDATE/DELETE pour anon/authenticated : lecture
-- réservée au service_role (bypass RLS par défaut).
