-- =============================================================================
--  0086 — Paire de baskets recommandée par le coach (03/11/2026)
--
--  Course à pied : à la création de séance, le coach choisit la paire de
--  l'athlète à utiliser (parmi SON matériel, table gear). Affichée dans
--  « À prévoir » (« baskets : Nike Pegasus 40 ») et utilisée en priorité
--  pour compter les km de la séance. Null = conseil automatique selon la
--  séance (recommendShoe côté app).
-- =============================================================================
alter table public.scheduled_sessions
  add column if not exists shoe_id uuid references public.gear(id) on delete set null;
