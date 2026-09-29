-- =============================================================================
--  0060_club_staff_reads_members.sql
--  Trouvé en testant le multi-club (0059/client myClubs staff) en direct sur
--  le compte de Rowan, ajouté admin du club réel de Quentin : le sélecteur
--  changeait bien de club, mais n'affichait qu'UN seul adhérent — lui-même
--  (la ligne club_members qu'il vient de rejoindre), jamais les 5 vrais
--  adhérents de Quentin. Cause : "club_members: owner all" (0001) ne
--  couvre que le PROPRIÉTAIRE ; un staff (role coach/admin) n'a de policy
--  que pour SA PROPRE ligne ("self reads"), jamais les autres. Même trou
--  que 0058 avait comblé côté scheduled_sessions, mais laissé ouvert ici.
-- =============================================================================
drop policy if exists "club_members: staff reads all" on club_members;
create policy "club_members: staff reads all" on club_members
  for select using (
    exists (
      select 1 from club_members mine
      where mine.club_id = club_members.club_id
        and mine.athlete_id = auth.uid()
        and mine.role in ('coach','admin')
    )
  );

-- Même trou pour la lecture des profils des adhérents (0057 ne couvrait
-- que le propriétaire) — sans ça la liste se remplit mais chaque nom
-- retombe sur le placeholder "Athlète" (RLS profiles refuse en silence).
drop policy if exists "profiles: club staff reads members" on profiles;
create policy "profiles: club staff reads members" on profiles
  for select using (
    exists (
      select 1 from club_members target
      join club_members mine on mine.club_id = target.club_id
      where target.athlete_id = profiles.id
        and mine.athlete_id = auth.uid()
        and mine.role in ('coach','admin')
    )
  );
