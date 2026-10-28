-- =============================================================================
--  0075 — Sexe et année de naissance de l'athlète (28/10/2026)
--
--  Demandés à l'inscription des ATHLÈTES uniquement (un membre de club a un
--  espace athlète ; l'admin club et le coach n'en ont pas besoin). Facultatifs :
--  ils servent à affiner l'analyse physiologique (zones, rapport IA), pas au
--  fonctionnement du compte. Année plutôt qu'âge : ne se périme pas.
--  Visibles par le coach via la policy existante « athlete_profiles: coach reads ».
--  handle_new_user crée la ligne athlete_profiles quand l'un des deux est fourni.
-- =============================================================================

alter table public.athlete_profiles
  add column if not exists sex text check (sex in ('F', 'M', 'X')),
  add column if not exists birth_year smallint check (birth_year between 1900 and 2100);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  fn text := nullif(trim(m->>'first_name'), '');
  ln text := nullif(trim(m->>'last_name'), '');
  rl user_role := coalesce((m->>'role')::user_role, 'athlete');
  sx text := case when m->>'sex' in ('F', 'M', 'X') then m->>'sex' end;
  by smallint := case when (m->>'birth_year') ~ '^\d{4}$'
                       and (m->>'birth_year')::int between 1900 and extract(year from now())::int
                      then (m->>'birth_year')::smallint end;
begin
  insert into public.profiles (id, email, full_name, role, first_name, last_name, acquisition_source, acquisition_detail)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(concat_ws(' ', fn, ln)), ''), m->>'full_name', ''),
    rl,
    fn,
    ln,
    nullif(left(m->>'acquisition_source', 40), ''),
    nullif(left(m->>'acquisition_detail', 200), '')
  )
  on conflict (id) do nothing;

  if rl = 'athlete' and (sx is not null or by is not null) then
    insert into public.athlete_profiles (user_id, sex, birth_year)
    values (new.id, sx, by)
    on conflict (user_id) do update set sex = excluded.sex, birth_year = excluded.birth_year;
  end if;
  return new;
end $$;
