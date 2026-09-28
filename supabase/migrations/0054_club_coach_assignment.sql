-- =============================================================================
--  0054_club_coach_assignment.sql
--  Multi-coachs par club : un club peut avoir plusieurs coachs staff
--  (club_members.role='coach'). Chaque adhésion « Coaching + » (tier='coach')
--  doit être assignée à UN de ces coachs — c'est lui qui verra l'athlète dans
--  SON interface coach habituelle (roster coach_athlete), sans rien dupliquer.
--
--  Attribution "compte club" = pas de coaching_subscriptions perso pour cet
--  athlète, l'argent passe uniquement par club_memberships (déjà le cas).
--  Ce qui manquait : QUEL coach staff du club suit QUEL athlète, et le lien
--  coach_athlete qui en découle. Écriture réservée à l'edge function
--  club-assign-coach (même posture que club_memberships : service_role only).
-- =============================================================================

alter table club_memberships
  add column if not exists assigned_coach_id uuid references profiles(id) on delete set null;
create index if not exists idx_club_memberships_coach on club_memberships(assigned_coach_id);

-- Traçabilité : un coach_athlete créé par une assignation club porte l'id de
-- l'adhésion d'origine. Permet de le révoquer proprement (résiliation, ré-
-- assignation à un autre coach) SANS toucher aux liens coach_athlete
-- personnels (source_club_membership_id = null), qui restent hors de portée
-- de toute logique club.
alter table coach_athlete
  add column if not exists source_club_membership_id uuid references club_memberships(id) on delete set null;
create index if not exists idx_ca_source_membership on coach_athlete(source_club_membership_id);

-- Un coach ne peut être assigné à une adhésion que s'il est bien staff
-- (role='coach') du club de cette adhésion. Appelée par l'edge function
-- club-assign-coach avant d'écrire — pas de contrainte CHECK ici : une check
-- constraint ne serait pas ré-évaluée si le rôle du coach change plus tard
-- dans club_members, elle donnerait une fausse garantie.
create or replace function club_coach_is_staff(p_club_id uuid, p_coach_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from club_members
    where club_id = p_club_id and athlete_id = p_coach_id and role = 'coach'
  );
$$;
