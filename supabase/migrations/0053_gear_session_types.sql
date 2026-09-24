-- =============================================================================
--  0053_gear_session_types.sql (24/09/2026)
--  ---------------------------------------------------------------------------
--  Recommandation automatique de matériel par type de séance (demande Rowan) :
--  la colonne `gear.cat` existante (daily/tempo/race/trail) est un choix
--  UNIQUE par paire, pensée pour le catalogue de 70 modèles. Une même paire
--  sert souvent plusieurs usages (ex. Novablast = fractionné ET seuil/tempo)
--  → nouvelle colonne à choix MULTIPLES, taxonomie propre à l'usage
--  d'entraînement plutôt qu'au modèle :
--    easy     = entraînement endurance / récupération
--    interval = fractionné court / long
--    tempo    = seuil / tempo
--    race     = course / séance rapide
--  `cat` n'est PAS retiré (garde le badge d'usure existant sur la page
--  Matériel + le catalogue de 70 modèles) — les deux coexistent, cat sert de
--  repli quand session_types est vide (ancien matériel jamais retaggé).
-- =============================================================================
alter table gear add column if not exists session_types text[];
alter table gear add constraint gear_session_types_valid
  check (session_types is null or session_types <@ array['easy','interval','tempo','race']);
comment on column gear.session_types is
  'Types de séance pour lesquels cette paire est recommandée (choix multiple) : '
  'easy (endurance/récup), interval (fractionné court/long), tempo (seuil/tempo), '
  'race (course/séance rapide). NULL = jamais taggé, repli sur gear.cat (single) '
  'côté recommendShoe().';
