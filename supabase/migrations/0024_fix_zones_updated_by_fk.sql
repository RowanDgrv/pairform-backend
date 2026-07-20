-- ---------------------------------------------------------------------------
--  0024 — Correctif : athlete_zones.updated_by NE DOIT PAS bloquer la
--  suppression du coach qui a réglé les zones.
--  La 0020 déclarait `updated_by references profiles(id)` sans clause on delete
--  → supprimer un coach qui avait posé des zones échouait (FK violation).
--  On repasse en ON DELETE SET NULL (l'historique « qui a modifié » n'est pas
--  critique et ne doit pas empêcher la suppression d'un compte).
-- ---------------------------------------------------------------------------
alter table athlete_zones drop constraint if exists athlete_zones_updated_by_fkey;
alter table athlete_zones
  add constraint athlete_zones_updated_by_fkey
  foreign key (updated_by) references profiles(id) on delete set null;
