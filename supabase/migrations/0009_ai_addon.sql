-- =============================================================================
--  0009_ai_addon.sql
--  ADD-ON « Assistant IA » du COACH (option payante séparée, ~12 €/mois).
--  Donne accès au résumé + recommandations automatiques par séance.
--
--  Deux objets :
--    1. ai_addons            = l'entitlement (le coach a-t-il l'add-on actif ?)
--                             écrit UNIQUEMENT par le webhook Stripe (vérité).
--    2. session_summaries    = cache des résumés déjà générés par Claude
--                             (1 appel API max par séance, jamais recalculé).
--  Voir aussi PAIRFORM-AI-ADDON-PLAN.md (coût/marge/justification du prix).
-- =============================================================================

-- ---- Entitlement add-on IA (par coach) --------------------------------------
create table if not exists ai_addons (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles(id) on delete cascade,
  status                  sub_status not null default 'incomplete',
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  price_id                text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now()
);
-- non-unique (cohérent avec idx_subs_user) : on garde l'historique des abos ;
-- l'upsert se fait sur stripe_subscription_id, l'« actif ? » via has_ai_addon().
create index if not exists idx_ai_addons_user on ai_addons(user_id);

-- ---- Cache des résumés générés ----------------------------------------------
-- session_key = identifiant stable de la séance (scheduled_session.id si en base,
-- sinon un hash fourni par le front pour les séances démo).
create table if not exists session_summaries (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references profiles(id) on delete cascade,
  athlete_id    uuid references profiles(id) on delete set null,
  session_key   text not null,
  discipline    discipline,
  objective     text,
  bilan         jsonb not null,          -- le payload chiffré envoyé au modèle
  verdict       text,                    -- oui | partiel | non
  headline      text,
  bullets       jsonb,
  recos         jsonb,
  model         text,                    -- ex. claude-sonnet-4-6
  created_at    timestamptz not null default now(),
  unique (coach_id, session_key)
);
create index if not exists idx_summaries_coach on session_summaries(coach_id);

-- ---- Helper : le coach a-t-il l'add-on IA actif ? ---------------------------
create or replace function has_ai_addon(uid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from ai_addons
    where user_id = uid
      and status in ('active', 'trialing')
      and (current_period_end is null or current_period_end > now())
  );
$$;

-- ---- RLS ---------------------------------------------------------------------
alter table ai_addons         enable row level security;
alter table session_summaries enable row level security;

-- l'add-on : le coach lit le sien ; écriture = service_role (webhook) uniquement.
drop policy if exists ai_addons_owner_read on ai_addons;
create policy ai_addons_owner_read on ai_addons
  for select using (user_id = auth.uid());

-- les résumés : le coach lit/écrit les siens ; l'athlète concerné peut lire.
drop policy if exists summaries_coach_all on session_summaries;
create policy summaries_coach_all on session_summaries
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());

drop policy if exists summaries_athlete_read on session_summaries;
create policy summaries_athlete_read on session_summaries
  for select using (athlete_id = auth.uid());

-- updated_at auto sur ai_addons
drop trigger if exists trg_ai_addons_updated on ai_addons;
create trigger trg_ai_addons_updated before update on ai_addons
  for each row execute function touch_updated_at();
