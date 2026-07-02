-- =============================================================================
--  0008_coach_offers.sql
--  Le COACH vend son suivi à ses athlètes (abonnement mensuel récurrent).
--  Boucle la boucle avec 0007 (le coach relie son compte Stripe) :
--    0007 = le coach encaisse (Connect) · 0008 = l'athlète s'abonne au coach.
--
--  Connect-ready : l'argent va au coach si son compte est relié (charges_enabled),
--  sinon fallback Sillance. Écriture des abos = service_role (webhook) only.
-- =============================================================================

-- ---- Offre(s) de coaching d'un coach (tarif éditable) ------------------------
create table if not exists coach_offers (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references profiles(id) on delete cascade,
  name          text not null default 'Suivi coaching',
  price         numeric(8,2) not null,
  bill_interval text not null default 'month',
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists idx_coach_offers_coach on coach_offers(coach_id);

-- ---- Abonnement d'un athlète au suivi d'un coach ----------------------------
create table if not exists coaching_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  coach_id                uuid not null references profiles(id) on delete cascade,
  athlete_id              uuid not null references profiles(id) on delete cascade,
  offer_id                uuid references coach_offers(id) on delete set null,
  status                  sub_status not null default 'incomplete',
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  price_id                text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now()
);
create index if not exists idx_coachsub_coach   on coaching_subscriptions(coach_id);
create index if not exists idx_coachsub_athlete on coaching_subscriptions(athlete_id);

-- ---- updated_at (réutilise touch_updated_at de 0003) ------------------------
do $$
declare t text;
begin
  foreach t in array array['coach_offers','coaching_subscriptions'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s;', t);
    execute format(
      'create trigger trg_touch_%1$s before update on %1$s
       for each row execute function touch_updated_at();', t);
  end loop;
end $$;

create or replace view active_coaching_subscriptions as
  select * from coaching_subscriptions where status in ('trialing','active');

-- =============================================================================
--  ROW LEVEL SECURITY
-- =============================================================================
alter table coach_offers           enable row level security;
alter table coaching_subscriptions enable row level security;

-- Offres : lisibles par tous (l'athlète voit l'offre de son coach),
-- modifiables uniquement par le coach lui-même.
drop policy if exists "coach_offers: readable"     on coach_offers;
drop policy if exists "coach_offers: owner writes" on coach_offers;
create policy "coach_offers: readable" on coach_offers
  for select using (true);
create policy "coach_offers: owner writes" on coach_offers
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- Abonnements : le coach voit les siens, l'athlète voit les siens.
-- (Écriture = service_role/webhook only → aucune policy d'insert/update user.)
drop policy if exists "coaching_subs: coach reads"   on coaching_subscriptions;
drop policy if exists "coaching_subs: athlete reads" on coaching_subscriptions;
create policy "coaching_subs: coach reads" on coaching_subscriptions
  for select using (coach_id = auth.uid());
create policy "coaching_subs: athlete reads" on coaching_subscriptions
  for select using (athlete_id = auth.uid());

-- =============================================================================
--  SEED : une offre par défaut (99 €/mois) pour les coachs existants sans offre
-- =============================================================================
insert into coach_offers (coach_id, name, price)
select p.id, 'Suivi coaching', 99
from profiles p
where p.role = 'coach'
  and not exists (select 1 from coach_offers o where o.coach_id = p.id);
