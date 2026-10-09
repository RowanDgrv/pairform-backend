-- =============================================================================
--  0066_athlete_reads_coach_profile.sql
--  Gap trouvé en construisant la messagerie (0065) : aucune policy ne laisse
--  un athlète lire le profil (full_name) de SON coach — seul le sens inverse
--  existait ("profiles: coach reads athletes", 0001). Sans ça, l'interface
--  athlète ne peut pas afficher "Conversation avec Fred" ni nulle part
--  ailleurs le nom de son coach personnel ou du staff de son club.
--  Couvre deux cas : coach personnel (coach_athlete actif) ET staff/gérant
--  d'un club dont l'athlète est membre (coach de club, pas forcément lié en
--  coach_athlete individuel).
-- =============================================================================
create policy "profiles: athlete reads linked coach" on profiles
  for select using (
    exists (
      select 1 from coach_athlete
      where coach_id = profiles.id and athlete_id = auth.uid() and status = 'active'
    )
    or exists (
      select 1 from club_members mine
      join club_members staff on staff.club_id = mine.club_id and staff.role in ('coach','admin')
      where mine.athlete_id = auth.uid() and staff.athlete_id = profiles.id
    )
    or exists (
      select 1 from club_members mine
      join clubs c on c.id = mine.club_id
      where mine.athlete_id = auth.uid() and c.owner_id = profiles.id
    )
  );
