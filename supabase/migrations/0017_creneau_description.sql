-- =============================================================================
--  0017 — Contenu de séance sur les créneaux club
--  Le coach décrit la séance du créneau ; le front réserve l'affichage au
--  groupe assigné (group_id, déjà présent depuis 0001).
-- =============================================================================
alter table creneaux add column if not exists description text;
