-- =============================================================================
--  0085 — Habillage par club (02/11/2026)
--
--  Une seule interface Sillance, aux couleurs de chaque club (run club,
--  athlé, tri) : couleur principale, secondaire, fond, police, logo.
--  theme = { v, preset, accent, accent2, bg, font, logo } — logo en data URL
--  WebP/PNG réduite côté navigateur (≈ 160 px) : pas de bucket, pas de
--  changement de CSP (img-src data: déjà autorisé). Taille plafonnée.
--  theme_options = les PROPOSITIONS créées par Rowan pour ce club (tableau
--  de thèmes {id, label, …}) : écrites par l'admin SEULEMENT (admin-crm,
--  service_role). theme = l'habillage ACTIF : l'admin le pose librement ;
--  le gérant (propriétaire, RLS "clubs: owner all") peut seulement choisir
--  l'une des propositions, ou revenir au style Sillance (null).
--  Lecture : les membres ("clubs: member reads") voient l'habillage actif.
-- =============================================================================
alter table public.clubs add column if not exists theme jsonb;
alter table public.clubs add column if not exists theme_options jsonb not null default '[]'::jsonb;

alter table public.clubs drop constraint if exists clubs_theme_size;
alter table public.clubs add constraint clubs_theme_size
  check (theme is null or (jsonb_typeof(theme) = 'object' and octet_length(theme::text) <= 150000));
alter table public.clubs drop constraint if exists clubs_theme_options_size;
alter table public.clubs add constraint clubs_theme_options_size
  check (jsonb_typeof(theme_options) = 'array' and octet_length(theme_options::text) <= 600000);

comment on column public.clubs.theme is
  'Habillage actif : {v, id, label, preset, accent, accent2, bg, font, logo}. Null = style Sillance.';
comment on column public.clubs.theme_options is
  'Propositions d''habillage créées par l''admin ; le gérant choisit parmi elles.';

create or replace function public.clubs_theme_guard()
returns trigger language plpgsql as $$
declare is_admin boolean := coalesce(auth.role(), '') = 'service_role'
                         or current_user in ('postgres', 'supabase_admin');   -- admin-crm, ou CLI/SQL (dépannage)
begin
  if is_admin then return new; end if;
  if new.theme_options is distinct from old.theme_options then
    raise exception 'Seul Sillance peut créer les habillages du club.' using errcode = '42501';
  end if;
  if new.theme is distinct from old.theme and new.theme is not null
     and not exists (select 1 from jsonb_array_elements(old.theme_options) o where o = new.theme) then
    raise exception 'Cet habillage ne fait pas partie des propositions du club.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists clubs_theme_admin_only on public.clubs;
drop function if exists public.clubs_theme_admin_only();
drop trigger if exists clubs_theme_guard on public.clubs;
create trigger clubs_theme_guard before update on public.clubs
  for each row execute function public.clubs_theme_guard();
