-- =============================================================================
--  0042 — video_access : exige un vrai lien coach↔athlète actif
--  ---------------------------------------------------------------------------
--  Audit sécurité 23-24/08/2026 (point mineur) : la policy va_coach_all
--  (0011_video_access.sql) ne vérifiait que coach_id = auth.uid(), pas que
--  l'athlete_id ciblé fait bien partie du roster de ce coach. L'edge function
--  video-seats-set fait cette vérification (coach_athlete actif), mais un
--  appel direct au client (supabase.from('video_access').upsert(...)) la
--  contournait entièrement : un coach pouvait activer l'accès vidéo premium
--  pour un athlète hors de son roster. Impact limité (accès gratuit à du
--  contenu non sensible, pas une fuite de données), mais même contournement
--  de garde applicative qu'ailleurs — corrigé pour cohérence.
-- =============================================================================
drop policy if exists va_coach_all on video_access;
create policy va_coach_all on video_access
  for all
  using (coach_id = auth.uid() and is_coach_of(athlete_id))
  with check (coach_id = auth.uid() and is_coach_of(athlete_id));
