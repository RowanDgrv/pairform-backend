-- =============================================================================
--  0065_conversations.sql
--  Messagerie club (Rowan 09/10/2026) : un coach ouvre un fil avec UN athlète
--  ou avec TOUT un groupe d'entraînement (club_groups). Périmètre volontaire :
--  coach <-> athlète(s) uniquement, jamais athlète <-> athlète (décision
--  Rowan 09/10 — pas de modération à construire pour un club associatif).
--
--  Conception :
--   - conversations : le fil (direct = 1 coach + 1 athlète, group = 1 coach +
--     tous les membres d'un club_groups au moment de la création).
--   - conversation_participants : qui a accès au fil + son last_read_at
--     (source de vérité pour le badge "non lu" ET pour l'autorisation RLS des
--     messages — un coach doit AUSSI être participant de ses propres fils
--     pour pouvoir lire/écrire les messages, cf. policies plus bas).
--   - conversation_messages : les messages eux-mêmes.
--  Limite assumée : rejoindre un groupe APRÈS la création de son fil de
--  discussion n'ajoute pas automatiquement le nouvel athlète au fil existant
--  (snapshot à la création, pas de sync continue) — à améliorer plus tard si
--  besoin réel.
-- =============================================================================

create type conversation_kind as enum ('direct', 'group');

create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  kind             conversation_kind not null,
  coach_id         uuid not null references profiles(id) on delete cascade,
  athlete_id       uuid references profiles(id) on delete cascade,      -- kind='direct'
  club_group_id    uuid references club_groups(id) on delete cascade,   -- kind='group'
  title            text,              -- nom du groupe au moment de la création (survit si le groupe est renommé)
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  constraint conversations_kind_target check (
    (kind = 'direct' and athlete_id is not null and club_group_id is null)
    or (kind = 'group' and club_group_id is not null and athlete_id is null)
  )
);
create index if not exists idx_conv_coach on conversations(coach_id);
create index if not exists idx_conv_athlete on conversations(athlete_id) where athlete_id is not null;
create index if not exists idx_conv_group on conversations(club_group_id) where club_group_id is not null;
-- Un seul fil direct par paire coach/athlète : "ouvrir le chat" = créer ou
-- réutiliser, jamais dupliquer.
create unique index if not exists uq_conv_direct on conversations(coach_id, athlete_id) where kind='direct';

create table if not exists conversation_participants (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references profiles(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists idx_convpart_user on conversation_participants(user_id);

create table if not exists conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid not null references profiles(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 4000),
  created_at      timestamptz not null default now()
);
create index if not exists idx_convmsg_conv on conversation_messages(conversation_id, created_at);

-- Tient last_message_at à jour (tri de la liste des fils) sans aller-retour client.
create or replace function touch_conversation_last_message()
returns trigger language plpgsql as $$
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end;
$$;
drop trigger if exists trg_touch_conversation on conversation_messages;
create trigger trg_touch_conversation after insert on conversation_messages
  for each row execute function touch_conversation_last_message();

-- =============================================================================
--  HELPER RLS — même logique que club_coach_manages (0058) mais pour un
--  GROUPE entier plutôt qu'un athlète individuel : le gérant du club, OU un
--  coach/admin membre du même club, peut ouvrir un fil avec ce groupe.
-- =============================================================================
create or replace function club_coach_manages_group(p_group_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from club_groups g
    where g.id = p_group_id
      and (
        owns_club(g.club_id)
        or exists (
          select 1 from club_members mine
          where mine.club_id = g.club_id
            and mine.athlete_id = auth.uid()
            and mine.role in ('coach','admin')
        )
      )
  );
$$;

-- =============================================================================
--  RLS
-- =============================================================================
alter table conversations             enable row level security;
alter table conversation_participants enable row level security;
alter table conversation_messages     enable row level security;

-- ---- CONVERSATIONS ----
create policy "conv: coach all" on conversations
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
create policy "conv: participant reads" on conversations
  for select using (exists (
    select 1 from conversation_participants p where p.conversation_id = id and p.user_id = auth.uid()
  ));

-- ---- PARTICIPANTS ----
-- Le coach gère les participants de SES fils (y ajoute l'athlète/les membres
-- du groupe, et lui-même — nécessaire pour pouvoir lire/écrire ses propres
-- messages, cf. policies messages plus bas qui ne regardent QUE cette table).
create policy "convpart: coach manages own conv" on conversation_participants
  for all using (exists (
    select 1 from conversations c where c.id = conversation_id and c.coach_id = auth.uid()
  )) with check (exists (
    select 1 from conversations c where c.id = conversation_id and c.coach_id = auth.uid()
  ));
create policy "convpart: participant reads own conv" on conversation_participants
  for select using (exists (
    select 1 from conversation_participants me
    where me.conversation_id = conversation_participants.conversation_id and me.user_id = auth.uid()
  ));
-- Marquer comme lu : chacun ne touche que sa propre ligne.
create policy "convpart: self update read" on conversation_participants
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- MESSAGES ----
-- Réservé aux participants du fil (coach INCLUS — d'où l'obligation de
-- l'insérer comme participant à la création, il n'y a pas de bypass coach_id
-- ici, par cohérence : un coach qui se retire d'un fil n'y a plus accès).
create policy "convmsg: participant reads" on conversation_messages
  for select using (exists (
    select 1 from conversation_participants p
    where p.conversation_id = conversation_messages.conversation_id and p.user_id = auth.uid()
  ));
create policy "convmsg: participant sends" on conversation_messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from conversation_participants p
      where p.conversation_id = conversation_messages.conversation_id and p.user_id = auth.uid()
    )
  );

-- =============================================================================
--  REALTIME — jamais utilisé dans Sillance avant ce chantier (audit 09/10/2026 :
--  aucun sb.channel()/postgres_changes nulle part dans le repo). Sans cette
--  ligne, l'ajout à la publication supabase_realtime, les nouveaux messages
--  n'arrivent jamais en live côté client, seulement au prochain refetch.
-- =============================================================================
alter publication supabase_realtime add table conversation_messages;
