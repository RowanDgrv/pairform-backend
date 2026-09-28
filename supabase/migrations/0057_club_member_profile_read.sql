-- =============================================================================
--  0057_club_member_profile_read.sql
--  Bug remonté par Rowan (28/09/2026) : deux athlètes ajoutés au club de
--  Muret via accept-club-invite (0055) apparaissent dans l'onglet Adhérents
--  SANS NOM. Cause double :
--   1) accept-club-invite insère club_members avec juste {club_id,
--      athlete_id, role} — jamais de nom capturé.
--   2) même en joignant profiles(full_name) côté front, la policy
--      "profiles: coach reads athletes" ne couvre que is_coach_of() (lien
--      coach_athlete perso) — un gérant de club qui n'a PAS ce lien avec
--      l'athlète (cas normal : rejoint le club sans être son coach perso)
--      ne peut lire AUCUNE ligne profiles de ses adhérents. RLS bloque
--      silencieusement, donc le nom reste vide côté front quel que soit
--      le SELECT écrit.
--  Fix : le gérant du club peut lire le profil (nom, email, avatar) de
--  tout athlète qui est membre de SON club — même périmètre que ce que
--  club_members expose déjà à travers "club_members: owner all" (0001),
--  juste étendu à la table profiles qu'il référence.
-- =============================================================================

drop policy if exists "profiles: club owner reads members" on profiles;
create policy "profiles: club owner reads members" on profiles
  for select using (
    exists (
      select 1 from club_members m
      where m.athlete_id = profiles.id
        and owns_club(m.club_id)
    )
  );
