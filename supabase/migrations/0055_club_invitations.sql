-- =============================================================================
--  0055_club_invitations.sql
--  Invitations à REJOINDRE UN CLUB (club_members), distinctes des invitations
--  coach → athlète (`invitations`, table 0003) : celles-ci ne créaient jamais
--  de ligne club_members, donc le lien partagé par un coach de club pour
--  "inviter dans le club" ne faisait jamais rejoindre le club (bug remonté
--  28/09/2026) — juste un lien de coaching perso.
--
--  Table séparée plutôt que réutiliser `invitations` : coach_id y est NOT
--  NULL et la contrainte unique (coach_id,email) ne correspond pas au cas
--  club (invitation portée par le club, pas par un coach précis).
-- =============================================================================
create table if not exists club_invitations (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id) on delete cascade,
  email       text not null,
  token       text not null unique default encode(gen_random_bytes(16), 'hex'),
  status      text not null default 'pending',   -- pending | accepted | revoked | expired
  invited_by  uuid not null references profiles(id) on delete cascade,
  member_id   uuid references club_members(id) on delete set null,  -- rempli à l'acceptation
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  unique (club_id, email)
);
create index if not exists idx_club_invites_club on club_invitations(club_id);
create index if not exists idx_club_invites_email on club_invitations(lower(email));

alter table club_invitations enable row level security;

-- Le gérant du club gère ses invitations (même posture que "invites: coach manages").
drop policy if exists "club_invites: owner manages" on club_invitations;
create policy "club_invites: owner manages" on club_invitations
  for all using (owns_club(club_id)) with check (owns_club(club_id));

-- L'invité (une fois connecté avec le bon email) peut voir l'invitation qui le concerne.
drop policy if exists "club_invites: invitee reads" on club_invitations;
create policy "club_invites: invitee reads" on club_invitations
  for select using (lower(email) = lower(coalesce(auth.jwt()->>'email','')));
