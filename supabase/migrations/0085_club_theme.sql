-- =============================================================================
--  0085 — Habillage par club (02/11/2026)
--
--  Une seule interface Sillance, aux couleurs de chaque club (run club,
--  athlé, tri) : couleur principale, secondaire, fond, police, logo.
--  theme = { v, preset, accent, accent2, bg, font, logo } — logo en data URL
--  WebP/PNG réduite côté navigateur (≈ 160 px) : pas de bucket, pas de
--  changement de CSP (img-src data: déjà autorisé). Taille plafonnée.
--  RLS inchangée : le propriétaire écrit ("clubs: owner all"), les membres
--  lisent ("clubs: member reads") → ils voient l'habillage de leur club.
-- =============================================================================
alter table public.clubs add column if not exists theme jsonb;

alter table public.clubs drop constraint if exists clubs_theme_size;
alter table public.clubs add constraint clubs_theme_size
  check (theme is null or (jsonb_typeof(theme) = 'object' and octet_length(theme::text) <= 150000));

comment on column public.clubs.theme is
  'Habillage du club : {v, preset, accent, accent2, bg, font, logo(data URL ≤ ~100 Ko)}. Null = thème Sillance.';
