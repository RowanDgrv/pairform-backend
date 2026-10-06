-- =============================================================================
--  0063_club_trial_days.sql
--  Durée d'essai gratuit personnalisable par club (avant le paywall club).
--  NULL = durée par défaut (TRIAL_DAYS côté front, 14 jours aujourd'hui).
--  Réglable par club via admin-crm (action setClubTrialDays) — permet
--  d'accorder 7j, 30j ou autre à un club donné sans toucher au code.
-- =============================================================================
alter table clubs
  add column if not exists trial_days integer;
