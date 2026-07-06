-- =============================================================================
--  0015_parental_consent.sql — Consentement parental des membres mineurs
--  -----------------------------------------------------------------------------
--  En France, le traitement des données d'un mineur de moins de 15 ans dans le
--  cadre d'un service en ligne requiert le consentement du ou des titulaires de
--  l'autorité parentale (art. 8 RGPD + loi Informatique et Libertés). Les clubs
--  pouvant inscrire des athlètes mineurs, on enregistre ici, de façon auditable,
--  le statut « mineur » et la preuve du recueil de l'autorisation parentale
--  (nom + e-mail du représentant légal, horodatage du consentement).
--
--  La RLS existante sur club_members s'applique (le gestionnaire du club gère ses
--  membres ; l'athlète lit sa propre ligne) — aucune nouvelle policy nécessaire.
--  Idempotent.
-- =============================================================================

alter table club_members add column if not exists is_minor boolean not null default false;
alter table club_members add column if not exists birth_date date;
alter table club_members add column if not exists guardian_name text;
alter table club_members add column if not exists guardian_email text;
alter table club_members add column if not exists guardian_consent_at timestamptz;

comment on column club_members.is_minor is 'Athlète mineur (< 18 ans) : déclenche le circuit de consentement parental.';
comment on column club_members.guardian_consent_at is 'Horodatage du recueil de l''autorisation du représentant légal ; NULL = consentement manquant.';
