-- =============================================================================
--  0068_fix_conversations_cross_recursion.sql
--  0067 ne suffisait pas : la récursion n'était pas seulement sur
--  conversation_participants elle-même, mais CROISÉE entre deux tables —
--  "conv: participant reads" (sur conversations) interrogeait
--  conversation_participants, et "convpart: coach manages own conv" (sur
--  conversation_participants) interrogeait conversations : chacune
--  déclenche la RLS de l'autre, qui déclenche de nouveau la première, boucle
--  infinie. Toujours "infinite recursion detected in policy for relation
--  conversation_participants" en testant en direct après 0067.
--  Fix : même fonction SECURITY DEFINER (is_conversation_participant, 0067)
--  réutilisée ici pour casser le cycle — la RLS de conversations ne
--  redéclenche plus celle de conversation_participants.
-- =============================================================================
drop policy if exists "conv: participant reads" on conversations;
create policy "conv: participant reads" on conversations
  for select using (is_conversation_participant(id, auth.uid()));
