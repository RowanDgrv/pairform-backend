-- =============================================================================
--  0058_club_calendar.sql
--  Calendrier club (Rowan 28-29/09/2026) : une vue calendrier dans l'interface
--  club qui montre créneaux + compétitions + qui les athlètes ont un lien
--  direct vers leur propre calendrier. Trois briques manquantes pour que ce
--  soit réel (pas juste de la démo) :
--
--  1) Un coach de club doit pouvoir gérer le planning (scheduled_sessions)
--     d'un adhérent qui n'est PAS forcément son athlète personnel
--     (coach_athlete) — aujourd'hui "sched: coach manages athlete plan" ne
--     couvre que ce lien perso, donc rien de ce qui suit n'aurait d'effet
--     pour un vrai club sans ce trou comblé.
--  2) Un créneau peut porter une séance-type (session_template) que le coach
--     attache une fois ; quand un athlète s'inscrit, elle est copiée sur SON
--     calendrier directement (au lieu que le créneau reste une simple ligne
--     de présence déconnectée du plan d'entraînement).
--  3) Les "compétitions" club (objectifs par groupe, onglet Compétitions)
--     tournaient à 100% sur un tableau JS local (COMPETITIONS) — jamais
--     persistées. Sans table réelle, les faire apparaître sur le calendrier
--     club n'aurait de sens que pour la démo, pas pour un club connecté.
-- =============================================================================

-- ---- 1) accès du coach de club au planning de ses adhérents -----------------
-- Vrai dans les deux sens : gérant du club (owns_club), OU membre du même
-- club avec role coach/admin (club_members.role, cf. 0001/0054). Un simple
-- membre (role='member') n'obtient RIEN de plus qu'avant.
create or replace function club_coach_manages(p_athlete_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from club_members target
    where target.athlete_id = p_athlete_id
      and (
        owns_club(target.club_id)
        or exists (
          select 1 from club_members mine
          where mine.club_id = target.club_id
            and mine.athlete_id = auth.uid()
            and mine.role in ('coach','admin')
        )
      )
  );
$$;

drop policy if exists "sched: club coach manages member plan" on scheduled_sessions;
create policy "sched: club coach manages member plan" on scheduled_sessions
  for all using (club_coach_manages(athlete_id)) with check (club_coach_manages(athlete_id));

-- Un athlète pouvait lire/cocher ses séances mais jamais en INSÉRER une lui-
-- même (seul un coach écrivait, cf. 0001) — nécessaire pour qu'un athlète
-- qui s'inscrit à un créneau ATTACHÉ à AUCUN coach (rare mais possible, ex.
-- créneau libre) reçoive quand même sa séance sur son propre calendrier.
-- Scope strictement à ses propres lignes : ne change rien à la philosophie
-- "le coach construit le plan", juste un repli pour ce cas précis.
drop policy if exists "sched: athlete inserts own" on scheduled_sessions;
create policy "sched: athlete inserts own" on scheduled_sessions
  for insert with check (athlete_id = auth.uid());

-- ---- 1b) créneaux/présence : le trou qui bloquait tout le reste -------------
-- "creneaux: owner all" (0001) ne couvrait QUE le gérant — un coach staff
-- (club_members.role='coach'/'admin', multi-coachs depuis 0054) ne pouvait
-- pas attacher de séance-type à un créneau. Et "attendees: club owner all"
-- ne couvrait QUE l'écriture par le gérant : le bouton "s'inscrire" d'un
-- créneau (renderCreneaux) n'a jamais persisté quoi que ce soit pour un
-- compte réel, il ne touchait qu'un tableau JS local — d'où l'audit du
-- 22/09/2026 qui trouvait CRENEAUX toujours avec attendees:[] à l'hydrate.
drop policy if exists "creneaux: owner all" on creneaux;
create policy "creneaux: owner all" on creneaux
  for all using (owns_club(club_id) or exists (
    select 1 from club_members m where m.club_id = creneaux.club_id
      and m.athlete_id = auth.uid() and m.role in ('coach','admin')
  )) with check (owns_club(club_id) or exists (
    select 1 from club_members m where m.club_id = creneaux.club_id
      and m.athlete_id = auth.uid() and m.role in ('coach','admin')
  ));

-- creneau_attendees.athlete_id référence club_members(id) (l'ADHÉSION, pas
-- directement profiles) — l'auto-inscription vérifie donc que la ligne
-- club_members ciblée appartient bien à l'utilisateur connecté.
drop policy if exists "attendees: member self manages own" on creneau_attendees;
create policy "attendees: member self manages own" on creneau_attendees
  for all using (
    exists (select 1 from club_members m where m.id = creneau_attendees.athlete_id and m.athlete_id = auth.uid())
  ) with check (
    exists (select 1 from club_members m where m.id = creneau_attendees.athlete_id and m.athlete_id = auth.uid())
  );

-- ---- 2) séance-type attachée à un créneau -----------------------------------
alter table creneaux add column if not exists session_template jsonb;

-- ---- 3) compétitions club, persistées ---------------------------------------
create table if not exists club_competitions (
  id              uuid primary key default gen_random_uuid(),
  club_id         uuid not null references clubs(id) on delete cascade,
  name            text not null,
  date            date not null,
  level           text not null default 'departemental',
  target_group_id uuid references club_groups(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_club_comp_club on club_competitions(club_id);
create index if not exists idx_club_comp_date on club_competitions(date);

create table if not exists club_competition_responses (
  competition_id uuid not null references club_competitions(id) on delete cascade,
  athlete_id     uuid not null references profiles(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending','confirmed','declined')),
  updated_at     timestamptz not null default now(),
  primary key (competition_id, athlete_id)
);

alter table club_competitions enable row level security;
alter table club_competition_responses enable row level security;

drop policy if exists "club_comp: owner/coach manage" on club_competitions;
create policy "club_comp: owner/coach manage" on club_competitions
  for all using (owns_club(club_id) or exists (
    select 1 from club_members m where m.club_id = club_competitions.club_id
      and m.athlete_id = auth.uid() and m.role in ('coach','admin')
  )) with check (owns_club(club_id) or exists (
    select 1 from club_members m where m.club_id = club_competitions.club_id
      and m.athlete_id = auth.uid() and m.role in ('coach','admin')
  ));

drop policy if exists "club_comp: member reads" on club_competitions;
create policy "club_comp: member reads" on club_competitions
  for select using (is_club_member(club_id));

drop policy if exists "club_comp_resp: athlete manages own" on club_competition_responses;
create policy "club_comp_resp: athlete manages own" on club_competition_responses
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());

drop policy if exists "club_comp_resp: club coach reads" on club_competition_responses;
create policy "club_comp_resp: club coach reads" on club_competition_responses
  for select using (
    exists (
      select 1 from club_competitions c
      where c.id = club_competition_responses.competition_id
        and (owns_club(c.club_id) or exists (
          select 1 from club_members m where m.club_id = c.club_id
            and m.athlete_id = auth.uid() and m.role in ('coach','admin')
        ))
    )
  );
