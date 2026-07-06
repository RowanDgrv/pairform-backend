-- =============================================================================
--  0014_fix_coach_athlete_rls.sql — CORRECTIF SÉCURITÉ CRITIQUE
--  -----------------------------------------------------------------------------
--  Faille (prouvée par test d'intrusion, 06/07/2026) : la policy
--  « coach_athlete: coach manages » (FOR ALL, CHECK coach_id = auth.uid())
--  laissait N'IMPORTE QUEL coach authentifié INSÉRER un lien
--  coach_athlete(coach_id = lui-même, athlete_id = <n'importe qui>, status
--  = 'active' par défaut). Comme is_coach_of() ne teste que l'existence de ce
--  lien, l'attaquant devenait « coach de » sa victime et lisait aussitôt :
--  profiles (nom + email), athlete_profiles (FTP/FC), checkins, records, gear,
--  external_activities (hors Strava). Escalade horizontale = fuite de données
--  de tout athlète de la plateforme.
--
--  Le lien LÉGITIME est créé uniquement par l'edge function accept-invite
--  (service_role, qui contourne la RLS) après acceptation d'une invitation.
--  Le client n'a donc aucune raison d'écrire directement dans coach_athlete.
--
--  Correctif : on retire la policy FOR ALL et on ne laisse au client que la
--  LECTURE de ses propres liens (le coach lit les siens, l'athlète les siens).
--  Plus aucune écriture côté client → l'auto-déclaration est impossible.
--  Idempotent.
-- =============================================================================

-- Retire la policy permissive (couvrait SELECT/INSERT/UPDATE/DELETE pour le coach).
drop policy if exists "coach_athlete: coach manages" on coach_athlete;

-- Le coach lit UNIQUEMENT ses propres liens (aucune écriture).
drop policy if exists "coach_athlete: coach reads" on coach_athlete;
create policy "coach_athlete: coach reads" on coach_athlete
  for select using (coach_id = auth.uid());

-- (La policy « coach_athlete: athlete reads » (SELECT athlete_id = auth.uid())
--  reste inchangée. Aucune policy INSERT/UPDATE/DELETE pour le rôle authenticated
--  => RLS refuse toute écriture directe ; seule l'edge function accept-invite,
--  en service_role, crée le lien après une invitation acceptée.)
