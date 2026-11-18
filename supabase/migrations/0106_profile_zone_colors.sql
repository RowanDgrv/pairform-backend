-- =============================================================================
-- 0106 — Couleurs des zones gardées sur le compte (18/11/2026)
-- Le choix fait dans Paramètres → Couleurs des zones (sillance-zone-colors.js)
-- n'était gardé que sur l'appareil. On le garde aussi dans le profil pour le
-- retrouver sur téléphone et ordinateur. Format : {"preset":"bordeaux","custom":{...}|null}.
-- Écriture : par le propriétaire du profil (policy existante de mise à jour de son
-- profil ; le garde guard_profile_sensitive ne concerne pas cette colonne).
-- Taille bornée pour éviter tout stockage abusif.
-- =============================================================================
alter table profiles add column if not exists zone_colors jsonb
  check (zone_colors is null or (jsonb_typeof(zone_colors) = 'object' and length(zone_colors::text) < 1000));
