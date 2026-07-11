-- =============================================================================
--  0018 — Récurrence des créneaux club
--  weekly (défaut) = se répète chaque semaine (jour + heure)
--  once            = séance ponctuelle, datée (colonne date)
-- =============================================================================
alter table creneaux add column if not exists recur text not null default 'weekly'
  check (recur in ('weekly','once'));
alter table creneaux add column if not exists date date;
