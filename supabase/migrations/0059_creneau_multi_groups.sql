-- =============================================================================
--  0059_creneau_multi_groups.sql
--  Un créneau ne pouvait cibler qu'UN groupe (group_id) ou tout le club (null).
--  Rowan (29/09/2026) veut pouvoir ouvrir un créneau à PLUSIEURS groupes
--  précis (ex. "Compétition" + "Adultes Half", sans les Jeunes) — pas
--  seulement "un groupe" ou "tout le monde".
--
--  group_ids remplace group_id comme source de vérité côté front (0059+) ;
--  group_id est CONSERVÉ (colonne existante, jamais droppée) et tenu
--  synchronisé à group_ids[1] par le front à l'écriture, pour ne rien
--  casser côté requêtes SQL existantes qui le liraient encore.
--  Tableau vide = ouvert à tout le club (même sémantique que group_id null).
-- =============================================================================
alter table creneaux add column if not exists group_ids uuid[] not null default '{}';

-- backfill : les créneaux déjà groupés gardent leur groupe unique.
update creneaux set group_ids = array[group_id] where group_id is not null and group_ids = '{}';

-- =============================================================================
--  "Sync complète" (29/09/2026) : quand le coach attache/modifie une séance
--  sur un créneau, elle est poussée automatiquement à tous les inscrits déjà
--  présents (pas seulement les futurs). Sans clé pour retrouver "la séance
--  posée pour CE créneau", ré-enregistrer le contenu (ou qu'un athlète
--  rejoigne/quitte/rejoigne) créerait un doublon à chaque fois plutôt que de
--  remplacer la séance existante. source_creneau_id permet un vrai upsert
--  (delete-puis-insert côté client, cf. scheduleSessionFromCreneau).
-- =============================================================================
alter table scheduled_sessions add column if not exists source_creneau_id uuid references creneaux(id) on delete set null;
create index if not exists idx_sched_source_creneau on scheduled_sessions(source_creneau_id);

-- Le delete-puis-insert ci-dessus doit marcher pour l'auto-inscription (SOI-
-- MÊME, sans coach) : "sched: athlete inserts own" (0058) couvrait l'insert
-- mais aucune policy self ne couvrait delete — la seule policy "for all"
-- existante (club_coach_manages/is_coach_of) ne s'applique pas quand
-- l'athlète agit seul sur son propre lien créneau.
drop policy if exists "sched: athlete deletes own" on scheduled_sessions;
create policy "sched: athlete deletes own" on scheduled_sessions
  for delete using (athlete_id = auth.uid());
