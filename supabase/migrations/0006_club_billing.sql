-- =============================================================================
--  0006_club_billing.sql
--  Facturation des 3 FORMULES CLUB (vendues par un club à ses adhérents) :
--    • dropin = « À la séance »      → one-shot (géré par creneau-checkout)
--    • sub    = « Abonnement club »  → abonnement mensuel récurrent
--    • coach  = « Coaching + »       → abonnement mensuel récurrent (premium)
--
--  Modèle CONNECT-READY :
--    - Si le club a relié son compte Stripe (stripe_account_id + charges_enabled),
--      l'argent va AU CLUB (destination charges) avec commission plateforme.
--    - Sinon, fallback : PairForm encaisse → la démo fonctionne immédiatement,
--      et la bascule en Connect est automatique dès que le club s'onboarde.
--
--  Écriture des adhésions = SERVICE_ROLE uniquement (le webhook Stripe fait foi).
-- =============================================================================

-- ---- enum des paliers d'offre -------------------------------------------------
do $$ begin
  create type club_offer_tier as enum ('dropin','sub','coach');
exception when duplicate_object then null; end $$;

-- ---- Connect : compte Stripe du club + statut d'encaissement ------------------
alter table clubs
  add column if not exists stripe_account_id text,
  add column if not exists charges_enabled   boolean not null default false;

-- ---- Les 3 formules d'un club (tarifs ÉDITABLES par le club) ------------------
create table if not exists club_offers (
  id            uuid primary key default gen_random_uuid(),
  club_id       uuid not null references clubs(id) on delete cascade,
  tier          club_offer_tier not null,
  price         numeric(8,2) not null,            -- en euros
  bill_interval text not null default 'month',    -- 'month' (sub/coach) | 'one_time' (dropin)
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (club_id, tier)
);
create index if not exists idx_club_offers_club on club_offers(club_id);

-- ---- Adhésions récurrentes d'un membre à une formule (sub | coach) ------------
create table if not exists club_memberships (
  id                      uuid primary key default gen_random_uuid(),
  club_id                 uuid not null references clubs(id) on delete cascade,
  member_id               uuid not null references club_members(id) on delete cascade,
  tier                    club_offer_tier not null,
  status                  sub_status not null default 'incomplete',
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  price_id                text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now()
);
create index if not exists idx_club_memberships_club   on club_memberships(club_id);
create index if not exists idx_club_memberships_member on club_memberships(member_id);

-- ---- updated_at automatique (réutilise touch_updated_at de 0003) --------------
do $$
declare t text;
begin
  foreach t in array array['club_offers','club_memberships'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s;', t);
    execute format(
      'create trigger trg_touch_%1$s before update on %1$s
       for each row execute function touch_updated_at();', t);
  end loop;
end $$;

-- ---- Vue pratique : adhésions actives ----------------------------------------
create or replace view active_club_memberships as
  select * from club_memberships where status in ('trialing','active');

-- =============================================================================
--  ROW LEVEL SECURITY
-- =============================================================================
alter table club_offers      enable row level security;
alter table club_memberships enable row level security;

-- Offres : lisibles par tous (page de réservation / lien d'invitation),
-- modifiables uniquement par le gérant du club.
drop policy if exists "club_offers: readable"     on club_offers;
drop policy if exists "club_offers: owner writes" on club_offers;
create policy "club_offers: readable" on club_offers
  for select using (true);
create policy "club_offers: owner writes" on club_offers
  for all using (owns_club(club_id)) with check (owns_club(club_id));

-- Adhésions : le gérant voit toutes celles de son club ; le membre voit la sienne.
-- (Aucune policy d'écriture pour les users → seul le service_role/webhook écrit.)
drop policy if exists "club_memberships: owner reads"      on club_memberships;
drop policy if exists "club_memberships: member reads own" on club_memberships;
create policy "club_memberships: owner reads" on club_memberships
  for select using (owns_club(club_id));
create policy "club_memberships: member reads own" on club_memberships
  for select using (
    exists (select 1 from club_members m
            where m.id = club_memberships.member_id and m.athlete_id = auth.uid())
  );

-- =============================================================================
--  SEED : dote chaque club existant des 3 formules par défaut (15 / 59 / 119 €)
-- =============================================================================
insert into club_offers (club_id, tier, price, bill_interval)
select c.id, v.tier, v.price, v.bill_interval
from clubs c
cross join (values
  ('dropin'::club_offer_tier, 15,  'one_time'),
  ('sub'::club_offer_tier,    59,  'month'),
  ('coach'::club_offer_tier,  119, 'month')
) as v(tier, price, bill_interval)
on conflict (club_id, tier) do nothing;
