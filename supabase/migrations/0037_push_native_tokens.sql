-- =============================================================================
--  0037 — Jetons push natifs (iOS/Android) dans push_subscriptions
--  ---------------------------------------------------------------------------
--  Décision Phase 4a (audit app mobile, 05/08/2026) : étendre la table Web
--  Push existante plutôt qu'en créer une séparée, pour garder un seul point
--  de lecture côté edge functions (morning-digest, coach-alert-on-checkin)
--  quand elles doivent joindre "tous les points de push d'un utilisateur",
--  toutes plateformes confondues.
--
--  Un jeton natif (FCM sur Android, APNs brut sur iOS — voir _shared/apns.ts
--  pour pourquoi iOS n'est PAS routé via FCM) est une simple chaîne opaque,
--  sans les clés de chiffrement p256dh/auth du Web Push — colonne endpoint
--  réutilisée comme identifiant unique quelle que soit la plateforme.
-- =============================================================================
alter table push_subscriptions
  add column if not exists platform text not null default 'web' check (platform in ('web', 'ios', 'android'));

alter table push_subscriptions alter column p256dh drop not null;
alter table push_subscriptions alter column auth drop not null;

comment on column push_subscriptions.endpoint is
  'web: URL du service Web Push. ios/android: jeton FCM opaque (unique par appareil/install).';
comment on column push_subscriptions.p256dh is 'web uniquement (clé de chiffrement Web Push).';
comment on column push_subscriptions.auth is 'web uniquement (clé de chiffrement Web Push).';
