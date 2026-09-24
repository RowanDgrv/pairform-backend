-- =============================================================================
--  0051_activity_feeling.sql (24/09/2026)
--  ---------------------------------------------------------------------------
--  Nouvelle demande : dès qu'une activité est synchronisée (Strava/Coros/…),
--  à la prochaine connexion de l'athlète elle doit lui être présentée pour
--  qu'il saisisse son ressenti (RPE 1-10 + note libre) et le matériel utilisé
--  (chaussures/vélo, table `gear` existante) — flux BLOQUANT tant que ce n'est
--  pas rempli (choix explicite, pas une simple bannière).
--
--  `feeling_required` distingue les activités concernées par cette nouvelle
--  exigence de tout l'historique déjà synchronisé avant sa mise en place
--  (décision explicite : "à partir de maintenant", pas rétroactif) :
--    1. la colonne est d'abord ajoutée avec default FALSE → toutes les lignes
--       existantes sont backfillées à false par ce default, sans un seul
--       UPDATE à écrire ;
--    2. le default est ensuite basculé à TRUE → chaque future ligne insérée
--       (sync Strava/Coros, upload manuel, quelle que soit la fonction qui
--       insère) l'exige automatiquement, sans avoir à toucher chaque site
--       d'insertion.
-- =============================================================================
alter table external_activities add column if not exists feeling_required boolean not null default false;
alter table external_activities alter column feeling_required set default true;
comment on column external_activities.feeling_required is
  'true = activité synchronisée après la mise en place du flux ressenti+matériel '
  '(24/09/2026), doit être présentée à l''athlète tant que feeling_logged_at est '
  'NULL. false = activité antérieure, jamais redemandée (non rétroactif).';

alter table external_activities add column if not exists rpe smallint check (rpe is null or rpe between 1 and 10);
alter table external_activities add column if not exists feeling_note text;
alter table external_activities add column if not exists gear_id uuid references gear(id) on delete set null;
alter table external_activities add column if not exists feeling_logged_at timestamptz;
comment on column external_activities.feeling_logged_at is
  'Horodatage de saisie du ressenti+matériel par l''athlète. NULL = en attente '
  '(si feeling_required) — condition déclenchant l''invite bloquante à la '
  'prochaine connexion.';

-- L'athlète peut renseigner ressenti/matériel sur SES propres activités
-- (aucune policy update n'existait jusqu'ici sur cette table — écriture
-- réservée au service_role des edge functions de sync). `with check` empêche
-- de réassigner la ligne à quelqu'un d'autre.
create policy "extact: self update" on external_activities
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists idx_extact_pending_feeling on external_activities(user_id)
  where feeling_required and feeling_logged_at is null;
