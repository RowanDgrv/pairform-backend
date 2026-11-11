-- =============================================================================
--  0095 : l'athlète peut ouvrir lui-même le fil avec son coach (11/11/2026)
--  Jusqu'ici seul le coach pouvait créer une conversation (policy « conv: coach
--  all », 0065) : un athlète ne pouvait écrire qu'après un premier message du
--  coach, ou depuis une publication du club (start_post_discussion, 0069).
--  Même mécanique que 0069 : fonction SECURITY DEFINER qui vérifie le lien
--  coach_athlete actif, réutilise le fil direct existant, sinon le crée avec
--  ses deux participants. Jamais athlète <-> athlète.
--  p_coach_id : le coach visé quand l'athlète en a plusieurs (co-coaching) ;
--  null = son premier coach actif.
-- =============================================================================
create or replace function start_coach_conversation(p_coach_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_coach uuid;
  v_conv  uuid;
begin
  if v_uid is null then raise exception 'Non authentifié'; end if;
  select coach_id into v_coach from coach_athlete
   where athlete_id = v_uid and status = 'active'
     and (p_coach_id is null or coach_id = p_coach_id)
   order by created_at limit 1;
  if v_coach is null then raise exception 'Aucun coach relié'; end if;

  select id into v_conv from conversations
   where kind = 'direct' and coach_id = v_coach and athlete_id = v_uid and source_post_id is null;
  if v_conv is null then
    insert into conversations(kind, coach_id, athlete_id) values ('direct', v_coach, v_uid)
      returning id into v_conv;
  end if;
  insert into conversation_participants(conversation_id, user_id)
    values (v_conv, v_coach), (v_conv, v_uid)
    on conflict (conversation_id, user_id) do nothing;
  return v_conv;
end;
$$;
revoke all on function start_coach_conversation(uuid) from public;
-- Supabase donne aussi le droit d'exécution au rôle anon par défaut : on le retire (la fonction
-- refuse déjà un appel non connecté, mais autant ne pas l'exposer).
revoke all on function start_coach_conversation(uuid) from anon;
grant execute on function start_coach_conversation(uuid) to authenticated;
