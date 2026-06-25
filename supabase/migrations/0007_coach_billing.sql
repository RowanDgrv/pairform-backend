-- =============================================================================
--  0007_coach_billing.sql
--  Connect au niveau du COACH (profil) : un coach solo encaisse ses athlètes
--  via son propre compte Stripe connecté (en miroir du club, cf. 0006).
--
--  Le statut `charges_enabled` est mis à jour par le webhook (account.updated),
--  qui couvre désormais à la fois les clubs et les coachs (match par account_id).
-- =============================================================================

alter table profiles
  add column if not exists stripe_account_id text,
  add column if not exists charges_enabled   boolean not null default false;
