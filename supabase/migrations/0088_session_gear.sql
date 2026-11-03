-- =============================================================================
--  0088 — Matériel demandé par une séance (03/11/2026)
--
--  Clés du catalogue (sillance-equipment.js) : ['pullbuoy','paddles', …].
--  Rempli par le constructeur : objets cochés par le coach dans « Matériel
--  demandé » + objets détectés dans la notation (« 400 pull plaquettes »).
--  Affiché dans « À prévoir » de l'athlète et dans le rappel du matin.
-- =============================================================================
alter table public.scheduled_sessions
  add column if not exists gear text[];
