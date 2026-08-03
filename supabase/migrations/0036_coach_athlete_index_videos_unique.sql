-- Deux constats Backend/DB de l'audit pré-prod (03/08/2026) :
--
-- 1) Index composite manquant sur coach_athlete : myAthletes() (chemin
--    chaud, appelé à chaque hydratation) filtre par coach_id ET status.
--    Les index existants (coach_id seul, athlete_id seul, unique
--    coach_id+athlete_id) ne couvrent pas ce filtre à deux colonnes.
create index if not exists idx_ca_coach_status on coach_athlete(coach_id, status);

-- 2) Migration seed_videos (0002) pas réellement idempotente : `on conflict
--    do nothing` sans cible, sur une table sans contrainte unique — ne
--    protège en réalité contre rien (rejouer le seed dupliquerait les
--    lignes). Aucun doublon (disc,title) dans les données actuelles ;
--    contrainte ajoutée pour que tout futur re-seed soit réellement
--    idempotent avec `on conflict (disc, title) do nothing`.
alter table videos add constraint videos_disc_title_uq unique (disc, title);
