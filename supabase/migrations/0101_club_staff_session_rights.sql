-- =============================================================================
-- 0101 — Deux systèmes de séances séparés : CLUB et COACH PERSO (17/11/2026)
--
-- Demande Rowan : les séances du coach de club et celles du coach perso ont
-- chacune leur étiquette et n'interfèrent pas. Le club ne touche pas au plan du
-- coach perso, et inversement.
--
-- Avant :
--   * « sched: club coach manages member plan » (0058, FOR ALL) : le staff d'un
--     club lisait, modifiait et supprimait TOUTE séance d'un adhérent.
--   * « sched: coach manages athlete plan » (0001, FOR ALL) : le coach perso
--     pouvait de même supprimer les séances posées par le club.
--   * Rien en base ne disait si une séance était « du club ». Constat en prod
--     (AS Muret Triathlon) : 22 séances perso d'un adhérent affichées au club.
--
-- Après :
--   * scheduled_sessions.club_id : posé quand la séance est créée depuis le club
--     (staff qui ouvre un adhérent depuis le club, ou créneau). Séance du club =
--     club_id non nul OU source_creneau_id non nul.
--   * LECTURE : inchangée pour tous (le front masque les séances perso côté club,
--     sauf athlètes cochés dans « Voir les séances perso »).
--   * ÉCRITURE : le staff du club n'écrit que les séances du club ; le coach
--     perso n'écrit que les séances hors club. L'athlète garde ses droits.
--
-- Appliquer : npx supabase db query --linked -f <ce fichier>   (JAMAIS db push)
-- =============================================================================

alter table scheduled_sessions add column if not exists club_id uuid references clubs(id) on delete set null;
create index if not exists scheduled_sessions_club_idx on scheduled_sessions(club_id) where club_id is not null;

-- ---- reprise de l'existant ---------------------------------------------------
-- a) séances issues d'un créneau → club du créneau
update scheduled_sessions s set club_id = c.club_id
from creneaux c where s.source_creneau_id = c.id and s.club_id is null;

-- b) séance posée par le staff d'un club POUR un adhérent de ce club, quand ce
--    staff n'est PAS aussi son coach perso (sinon ambigu : on laisse en perso)
update scheduled_sessions s set club_id = t.club_id
from club_members t join clubs c on c.id = t.club_id
where s.club_id is null and s.source_creneau_id is null
  and t.athlete_id = s.athlete_id
  and s.created_by is not null and s.created_by <> s.athlete_id
  and (c.owner_id = s.created_by
       or exists (select 1 from club_members st where st.club_id = t.club_id
                  and st.athlete_id = s.created_by and st.role in ('coach','admin')))
  and not exists (select 1 from coach_athlete ca where ca.coach_id = s.created_by
                  and ca.athlete_id = s.athlete_id and ca.status = 'active');

-- ---- droits ------------------------------------------------------------------
-- staff du club p_club ET l'athlète en est adhérent
create or replace function club_staff_for(p_club uuid, p_athlete uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_club is not null
     and exists (select 1 from club_members t where t.club_id = p_club and t.athlete_id = p_athlete)
     and (owns_club(p_club) or club_member_is_staff(p_club, auth.uid()))
$$;

drop policy if exists "sched: club coach manages member plan" on scheduled_sessions;
drop policy if exists "sched: coach manages athlete plan" on scheduled_sessions;

-- club
drop policy if exists "sched: club staff reads member plan" on scheduled_sessions;
create policy "sched: club staff reads member plan" on scheduled_sessions
  for select using (club_coach_manages(athlete_id));
drop policy if exists "sched: club staff inserts club session" on scheduled_sessions;
create policy "sched: club staff inserts club session" on scheduled_sessions
  for insert with check (created_by = auth.uid() and club_staff_for(club_id, athlete_id));
drop policy if exists "sched: club staff updates club session" on scheduled_sessions;
create policy "sched: club staff updates club session" on scheduled_sessions
  for update using (club_staff_for(club_id, athlete_id) or (source_creneau_id is not null and club_coach_manages(athlete_id)))
  with check (club_staff_for(club_id, athlete_id) or (source_creneau_id is not null and club_coach_manages(athlete_id)));
drop policy if exists "sched: club staff deletes club session" on scheduled_sessions;
create policy "sched: club staff deletes club session" on scheduled_sessions
  for delete using (club_staff_for(club_id, athlete_id) or (source_creneau_id is not null and club_coach_manages(athlete_id)));

-- coach perso
drop policy if exists "sched: coach reads athlete plan" on scheduled_sessions;
create policy "sched: coach reads athlete plan" on scheduled_sessions
  for select using (is_coach_of(athlete_id));
drop policy if exists "sched: coach writes personal session" on scheduled_sessions;
create policy "sched: coach writes personal session" on scheduled_sessions
  for insert with check (is_coach_of(athlete_id) and club_id is null and source_creneau_id is null);
drop policy if exists "sched: coach updates personal session" on scheduled_sessions;
create policy "sched: coach updates personal session" on scheduled_sessions
  for update using (is_coach_of(athlete_id) and club_id is null and source_creneau_id is null)
  with check (is_coach_of(athlete_id) and club_id is null and source_creneau_id is null);
drop policy if exists "sched: coach deletes personal session" on scheduled_sessions;
create policy "sched: coach deletes personal session" on scheduled_sessions
  for delete using (is_coach_of(athlete_id) and club_id is null and source_creneau_id is null);
