-- =============================================================================
--  0050_activity_laps.sql (23/09/2026)
--  ---------------------------------------------------------------------------
--  L'analyse de séance ignorait les VRAIS laps de la montre (bouton lap
--  pressé pendant l'activité) et recalculait toujours des splits au km, même
--  quand l'athlète avait lappé toutes les 30s (ex. 15x30s actif). Strava les
--  fournit pourtant dans le détail d'activité (start_index/end_index, alignés
--  sur les streams) — juste jamais renvoyés ni mis en cache jusqu'ici.
--  Colonne jumelle de `points` (0026) : même logique de cache "ne rappelle
--  Strava que si vide".
-- =============================================================================
alter table external_activities add column if not exists laps jsonb;
comment on column external_activities.laps is
  'Vrais laps de la montre, au format [{start,end}] (indices dans `points`, '
  'end exclu — même convention que les laps extraits d''un .FIT). NULL/[] si '
  'l''activité n''a aucun lap manuel : l''app retombe sur son découpage '
  'automatique au km.';
