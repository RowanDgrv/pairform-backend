-- =============================================================================
--  0072 — Inscription : prénom, nom, provenance (« Où nous as-tu connu ? »)
--
--  Constat 27/10/2026 : full_name vide pour les 3 comptes coach (le champ
--  « Nom complet » était facultatif) → emails « Salut coach », « Ton coach
--  t'invite », athlète affiché par son préfixe d'email. Le formulaire
--  d'inscription demande désormais prénom + nom (obligatoires) et la
--  provenance ; handle_new_user les recopie depuis les métadonnées Auth.
--  full_name reste la colonne lue partout : il vaut « prénom nom ».
-- =============================================================================

alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists acquisition_source text,
  add column if not exists acquisition_detail text;

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
begin
  insert into public.profiles (id, email, full_name, role, first_name, last_name, acquisition_source, acquisition_detail)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(concat_ws(' ', fn, ln)), ''), m->>'full_name', ''),
    coalesce((m->>'role')::user_role, 'athlete'),
    fn,
    ln,
    nullif(left(m->>'acquisition_source', 40), ''),
    nullif(left(m->>'acquisition_detail', 200), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;
