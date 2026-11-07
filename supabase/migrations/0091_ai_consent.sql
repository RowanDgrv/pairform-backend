-- ============================================================
--  0091_ai_consent.sql (07/11/2026)
--  Consentement de l'athlète à l'analyse de ses données par l'Assistant IA
--  de son coach (politique de confidentialité 3.9, exigence Garmin) :
--    ai_consent = null  → pas d'avis exprimé : analyse autorisée (consentement
--                         donné à l'inscription), SAUF si l'athlète a Garmin
--                         connecté (Garmin exige un « oui » explicite)
--    ai_consent = true  → oui explicite (date dans ai_consent_at)
--    ai_consent = false → refus : aucune analyse IA de cet athlète
--  Écrit par l'athlète lui-même (policy « athlete_profiles: self all ») ;
--  lu par son coach (policy « coach reads ») et par les edge functions IA
--  (session-summary, session-report, week-review) qui refusent en 403.
--
--  Engagements du coach à la souscription de l'Assistant IA :
--  profiles.ai_terms_accepted_at (policy « profiles: self update »).
-- ============================================================
alter table athlete_profiles add column if not exists ai_consent boolean;
alter table athlete_profiles add column if not exists ai_consent_at timestamptz;
alter table profiles add column if not exists ai_terms_accepted_at timestamptz;
