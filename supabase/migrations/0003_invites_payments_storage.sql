-- =============================================================================
--  Sillance — Migration 0003
--  Ajoute : invitations coach→athlète, paiement des créneaux à la carte,
--  bucket Storage privé pour les vidéos, et triggers updated_at génériques.
-- =============================================================================

-- ---------------------------------------------------------------------------
--  updated_at automatique (générique)
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','athlete_profiles','subscriptions'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s;', t);
    execute format(
      'create trigger trg_touch_%1$s before update on %1$s
       for each row execute function touch_updated_at();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  INVITATIONS  (coach invite un athlète par email)
--  Parcours : coach crée une invite → l'athlète reçoit un lien avec le token →
--  il s'inscrit/se connecte → l'edge function `accept-invite` crée le lien
--  coach_athlete et passe l'invite à 'accepted'.
-- ---------------------------------------------------------------------------
create table if not exists invitations (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references profiles(id) on delete cascade,
  email       text not null,
  token       text not null unique default encode(gen_random_bytes(16), 'hex'),
  status      text not null default 'pending',   -- pending | accepted | revoked | expired
  athlete_id  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  unique (coach_id, email)
);
create index if not exists idx_invites_coach on invitations(coach_id);
create index if not exists idx_invites_email on invitations(lower(email));

alter table invitations enable row level security;

-- Le coach gère ses propres invitations.
create policy "invites: coach manages" on invitations
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
-- L'invité (une fois connecté avec le bon email) peut voir l'invitation qui le concerne.
create policy "invites: invitee reads" on invitations
  for select using (lower(email) = lower(coalesce(auth.jwt()->>'email','')));

-- ---------------------------------------------------------------------------
--  PAIEMENT DES CRÉNEAUX À LA CARTE
--  creneau_attendees.paid existe déjà ; on ajoute le suivi Stripe + une table
--  d'historique de paiements one-shot (mode 'payment', pas abonnement).
-- ---------------------------------------------------------------------------
alter table creneau_attendees
  add column if not exists stripe_session_id text,
  add column if not exists amount numeric;

create table if not exists creneau_payments (
  id                 uuid primary key default gen_random_uuid(),
  creneau_id         uuid not null references creneaux(id) on delete cascade,
  member_id          uuid not null references club_members(id) on delete cascade,
  stripe_session_id  text unique,
  amount             numeric,
  status             text not null default 'pending',  -- pending | paid | failed | refunded
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);
create index if not exists idx_crpay_creneau on creneau_payments(creneau_id);

alter table creneau_payments enable row level security;
-- Le propriétaire du club voit les paiements de ses créneaux (lecture).
create policy "creneau_payments: club owner reads" on creneau_payments
  for select using (exists (
    select 1 from creneaux c where c.id = creneau_id and owns_club(c.club_id)
  ));
-- L'écriture passe par le webhook (service_role) — aucune policy d'insert côté client.

-- ---------------------------------------------------------------------------
--  STORAGE — bucket privé pour les vidéos premium
--  Les fichiers ne sont jamais publics : l'app demande une URL signée à
--  l'edge function `video-url`, qui vérifie l'abonnement avant de la délivrer.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('videos', 'videos', false)
on conflict (id) do nothing;

-- Aucune policy de lecture publique : seul le service_role (edge function)
-- génère des URLs signées. Les utilisateurs n'accèdent pas au bucket en direct.

-- ---------------------------------------------------------------------------
--  Helper : l'utilisateur courant a-t-il un abonnement actif ? (pour gating)
-- ---------------------------------------------------------------------------
create or replace function has_active_subscription(target uuid default auth.uid())
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from subscriptions
    where user_id = target and status in ('active','trialing')
  );
$$;
