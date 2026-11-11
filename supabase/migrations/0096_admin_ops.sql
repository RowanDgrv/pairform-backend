-- =============================================================================
--  0096 : pilotage (Gestion Sillance, 11/11/2026)
--  Trois tables internes + une tâche planifiée, pour que le tableau de bord
--  local de l'admin lise de vraies données sans aucune clé sur son Mac :
--   - support_requests : les messages du formulaire de contact du site, qui
--     n'ouvrait jusqu'ici qu'un e-mail et n'enregistrait rien. Écriture seule
--     pour le public ; lecture réservée au serveur.
--   - admin_digests : file des résumés du matin déposés par le tableau de bord
--     local ; la fonction admin-ops les envoie par e-mail aux admins.
--   - admin_stripe_snapshot : photo des abonnements et factures Stripe, prise
--     par admin-ops avec la clé déjà présente côté serveur.
-- =============================================================================
create table if not exists support_requests (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null default '' check (char_length(name) <= 120),
  email       text not null check (char_length(email) between 5 and 200 and position('@' in email) > 1),
  role        text not null default '' check (char_length(role) <= 80),
  subject     text not null default '' check (char_length(subject) <= 160),
  message     text not null check (char_length(message) between 5 and 4000),
  lang        text not null default '' check (char_length(lang) <= 8),
  notified_at timestamptz
);
alter table support_requests enable row level security;
drop policy if exists "support: public insert" on support_requests;
-- Tout visiteur peut déposer un message ; personne ne peut les relire depuis le site
-- (aucune policy de lecture). notified_at n'est pas modifiable à l'insertion.
create policy "support: public insert" on support_requests
  for insert to anon, authenticated with check (notified_at is null);
revoke all on support_requests from anon, authenticated;
grant insert (name, email, role, subject, message, lang) on support_requests to anon, authenticated;

create table if not exists admin_digests (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  subject    text not null check (char_length(subject) <= 200),
  html       text not null check (char_length(html) <= 60000),
  sent_at    timestamptz,
  error      text
);
alter table admin_digests enable row level security;      -- aucune policy : serveur uniquement

create table if not exists admin_stripe_snapshot (
  id         smallint primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table admin_stripe_snapshot enable row level security;   -- aucune policy : serveur uniquement

-- Toutes les 15 min : même commande (et même secret) que le rappel de planification,
-- seule l'adresse de la fonction change.
select cron.unschedule(jobid) from cron.job where jobname = 'sillance-admin-ops';
select cron.schedule(
  'sillance-admin-ops',
  '7,22,37,52 * * * *',
  (select replace(command, '/functions/v1/coach-week-reminder', '/functions/v1/admin-ops')
     from cron.job where jobname = 'sillance-coach-week-reminder')
);
