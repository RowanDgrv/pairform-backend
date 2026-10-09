-- =============================================================================
--  0069_club_posts.sql
--  Fil du club (Rowan 09/10/2026) : le coach / l'admin du club publie pour
--  tout le club ou un groupe ("programme de la semaine en ligne"). Seul le
--  staff publie ; les membres lisent. Un athlète qui a une question clique
--  "Discuter de ça avec le coach" : un fil PRIVÉ coach<->athlète est ouvert,
--  rattaché à la publication (source_post_id), qui s'affiche épinglée en tête.
-- =============================================================================

create table if not exists club_posts (
  id             uuid primary key default gen_random_uuid(),
  club_id        uuid not null references clubs(id) on delete cascade,
  author_id      uuid not null references profiles(id) on delete cascade,
  club_group_id  uuid references club_groups(id) on delete set null,  -- null = tout le club
  body           text not null check (char_length(body) between 1 and 4000),
  created_at     timestamptz not null default now()
);
create index if not exists idx_club_posts_club on club_posts(club_id, created_at desc);

alter table club_posts enable row level security;

-- Staff = gérant (owns_club) ou membre coach/admin (club_member_is_staff,
-- SECURITY DEFINER, 0061 — jamais de sous-requête directe sur une table qui
-- relit celle-ci, cf. 0061/0067/0068).
create policy "club_posts: staff manages" on club_posts
  for all using (owns_club(club_id) or club_member_is_staff(club_id, auth.uid()))
  with check ((owns_club(club_id) or club_member_is_staff(club_id, auth.uid())) and author_id = auth.uid());

-- Membre : voit les publications de tout le club + celles de SON groupe.
create policy "club_posts: member reads" on club_posts
  for select using (exists (
    select 1 from club_members m
    where m.club_id = club_posts.club_id and m.athlete_id = auth.uid()
      and (club_posts.club_group_id is null or m.group_id = club_posts.club_group_id)
  ));

-- ---- Fils de discussion rattachés à une publication ----
alter table conversations add column if not exists source_post_id uuid references club_posts(id) on delete set null;

-- Un fil direct "général" par paire coach/athlète (inchangé), PLUS un fil
-- par (publication, athlète) — sinon "Discuter de ça" retomberait dans le
-- fil général et la publication n'aurait pas de contexte propre.
drop index if exists uq_conv_direct;
create unique index if not exists uq_conv_direct on conversations(coach_id, athlete_id)
  where kind = 'direct' and source_post_id is null;
create unique index if not exists uq_conv_post on conversations(source_post_id, athlete_id)
  where source_post_id is not null;

-- L'athlète ne peut pas créer de conversation lui-même ("conv: coach all"
-- exige coach_id = auth.uid()) : ouverture via RPC contrôlée, qui vérifie
-- qu'il a bien le droit de LIRE la publication avant de créer/réutiliser le fil.
create or replace function start_post_discussion(p_post_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_post club_posts%rowtype;
  v_conv uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Non authentifié'; end if;
  select * into v_post from club_posts where id = p_post_id;
  if not found then raise exception 'Publication introuvable'; end if;
  if v_post.author_id = v_uid then raise exception 'Auteur de la publication'; end if;
  if not exists (
    select 1 from club_members m
    where m.club_id = v_post.club_id and m.athlete_id = v_uid
      and (v_post.club_group_id is null or m.group_id = v_post.club_group_id)
  ) then raise exception 'Pas membre de ce club'; end if;

  select id into v_conv from conversations where source_post_id = p_post_id and athlete_id = v_uid;
  if v_conv is not null then return v_conv; end if;

  insert into conversations(kind, coach_id, athlete_id, source_post_id, title)
    values ('direct', v_post.author_id, v_uid, p_post_id, left(v_post.body, 80))
    returning id into v_conv;
  insert into conversation_participants(conversation_id, user_id)
    values (v_conv, v_post.author_id), (v_conv, v_uid);
  return v_conv;
end;
$$;
revoke all on function start_post_discussion(uuid) from public;
grant execute on function start_post_discussion(uuid) to authenticated;
