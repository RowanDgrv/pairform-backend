-- =============================================================================
--  0067_fix_conversation_participants_recursion.sql
--  Même bug que 0061 (club_members), cette fois sur conversation_participants :
--  "convpart: participant reads own conv" faisait un EXISTS (select ... from
--  conversation_participants ...) DANS une policy SUR conversation_participants
--  — Postgres réévalue RLS sur la sous-requête, qui retombe sur la même
--  policy, boucle infinie ("infinite recursion detected in policy for
--  relation conversation_participants", 42P17). Trouvé en testant en direct
--  (première conversation de groupe créée en prod, 09/10/2026) : listConversations
--  et openGroupConversation échouaient tous les deux.
--  Fix : même remède que 0061/0054/0058 — fonction SECURITY DEFINER qui
--  contourne RLS en interne, pas de réévaluation récursive.
-- =============================================================================
create or replace function is_conversation_participant(p_conversation_id uuid, p_uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from conversation_participants
    where conversation_id = p_conversation_id and user_id = p_uid
  );
$$;

drop policy if exists "convpart: participant reads own conv" on conversation_participants;
create policy "convpart: participant reads own conv" on conversation_participants
  for select using (is_conversation_participant(conversation_participants.conversation_id, auth.uid()));

-- Les policies messages passaient par une sous-requête directe sur
-- conversation_participants (RLS ré-évaluée dessus à chaque fois, donc
-- touchées indirectement par la même récursion) : basculées sur la même
-- fonction, plus rapide (bypass RLS) et plus lisible.
drop policy if exists "convmsg: participant reads" on conversation_messages;
create policy "convmsg: participant reads" on conversation_messages
  for select using (is_conversation_participant(conversation_messages.conversation_id, auth.uid()));

drop policy if exists "convmsg: participant sends" on conversation_messages;
create policy "convmsg: participant sends" on conversation_messages
  for insert with check (
    sender_id = auth.uid()
    and is_conversation_participant(conversation_messages.conversation_id, auth.uid())
  );
