-- =============================================================================
--  0025_coach_tiers.sql
--  Le SaaS coach passe d'un prix flat (29€/mois) à 3 paliers selon le nombre
--  d'athlètes coachés (1-10 / 11-30 / 31+), auto-déclarés par le coach au
--  moment de l'abonnement (même logique de confiance que club_offers).
--  Colonne informative seulement : le vrai prix facturé vit dans Stripe
--  (price_data dynamique), ceci sert juste à afficher/retrouver le palier.
-- =============================================================================
alter table subscriptions add column if not exists tier smallint;
comment on column subscriptions.tier is
  'Palier auto-déclaré du coach au moment de l''abonnement : 1 (1-10 athlètes), 2 (11-30), 3 (31+). NULL pour les plans non-coach.';
