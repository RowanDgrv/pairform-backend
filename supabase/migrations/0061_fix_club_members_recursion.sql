-- =============================================================================
--  0061_fix_club_members_recursion.sql
--  0060 cassait myClubs() en prod : "club_members: staff reads all" faisait
--  un EXISTS (select ... from club_members ...) DANS une policy SUR
--  club_members — Postgres réévalue RLS sur la sous-requête, qui retombe
--  sur la même policy, boucle infinie ("infinite recursion detected in
--  policy for relation club_members", 42P17). Trouvé en testant en direct
--  (Rowan admin chez Quentin) : le switcher perdait le 2e club d'un coup.
--  Fix : passer par une fonction SECURITY DEFINER (contourne RLS en
--  interne, pas de réévaluation récursive) — même remède que
--  club_coach_is_staff (0054) et club_coach_manages (0058), qu'on aurait
--  dû réutiliser directement au lieu d'inline le sous-select dans 0060.
-- =============================================================================
create or replace function club_member_is_staff(p_club_id uuid, p_uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from club_members
    where club_id = p_club_id and athlete_id = p_uid and role in ('coach','admin')
  );
$$;

drop policy if exists "club_members: staff reads all" on club_members;
create policy "club_members: staff reads all" on club_members
  for select using (club_member_is_staff(club_members.club_id, auth.uid()));

drop policy if exists "profiles: club staff reads members" on profiles;
create policy "profiles: club staff reads members" on profiles
  for select using (
    exists (
      select 1 from club_members target
      where target.athlete_id = profiles.id
        and club_member_is_staff(target.club_id, auth.uid())
    )
  );
