-- =============================================================================
--  0084 — Clés « coach » pour le connecteur Claude (01/11/2026)
--
--  Une clé assistant était liée à UN athlète (athlete_id). scope = 'coach' :
--  athlete_id porte alors l'id du COACH, et le connecteur sillance-mcp lui
--  ouvre ses athlètes (coach_athlete actif + membres des clubs où il est
--  propriétaire / staff) : lister, lire le planning, programmer, annuler une
--  séance non réalisée. Toute écriture → assistant_writes (avant / après).
-- =============================================================================
alter table public.assistant_tokens
  add column if not exists scope text not null default 'athlete' check (scope in ('athlete', 'coach'));

create or replace function public.assistant_mint_coach_token(p_coach uuid, p_label text default 'claude-coach')
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text;
begin
  if p_coach is null then raise exception 'coach requis'; end if;
  if not exists (select 1 from profiles where id = p_coach and role = 'coach') then
    raise exception 'ce compte n''est pas un compte coach';
  end if;
  v_token := 'sil_' || encode(gen_random_bytes(32), 'hex');
  insert into assistant_tokens (token_hash, athlete_id, label, can_write, scope)
  values (encode(digest(v_token, 'sha256'), 'hex'), p_coach, coalesce(p_label, 'claude-coach'), true, 'coach');
  return v_token;
end $$;
revoke all on function public.assistant_mint_coach_token(uuid, text) from public, anon, authenticated;
