-- =============================================================================
--  0013_gear_catalog.sql — Catégorie + prix pour le catalogue de chaussures
--
--  Le front (rebrand-sillance) a ajouté un catalogue de chaussures par marque
--  (recherche + parcours) : chaque modèle a une catégorie (daily/tempo/race/
--  trail) qui pilote le conseiller de paire et le garde-fou pré-course, et un
--  prix d'achat optionnel pour le coût au kilomètre affiché côté app.
--
--  cat  : catégorie du modèle (chaussures uniquement, NULL pour un vélo).
--  price: prix d'achat, optionnel.
--  Le "km de retrait moyen communauté" reste un attribut du catalogue côté
--  client (SHOE_CATALOG), pas une colonne : il évolue avec le catalogue, pas
--  avec l'équipement d'un athlète donné.
--
--  Idempotent (add column if not exists + contrainte posée seulement si absente).
-- =============================================================================

alter table gear add column if not exists cat   text;
alter table gear add column if not exists price numeric;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gear_cat_check') then
    alter table gear add constraint gear_cat_check check (cat in ('daily','tempo','race','trail'));
  end if;
end $$;
