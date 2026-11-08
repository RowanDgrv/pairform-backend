-- ============================================================
--  0092_watch_push_tracking.sql (08/11/2026)
--  Anti-doublon de l'envoi vers la montre (COROS) : createScheduledWorkout
--  crée une NOUVELLE séance à chaque appel, sans dédoublonnage côté COROS.
--  Cliquer deux fois « Envoyer la semaine » mettait donc chaque séance en
--  double sur la montre.
--    watch_pushed_at  → date du dernier envoi réussi (null = jamais envoyée)
--    watch_pushed_sig → empreinte (sha-256) du contenu envoyé : date, sport,
--                       titre, blocs, consigne. Si la séance a été modifiée
--                       ou déplacée depuis, l'empreinte ne correspond plus
--                       et le front prévient que l'ancienne version reste
--                       sur la montre.
--  Écrit uniquement par push-session-to-watch (service_role).
-- ============================================================
alter table scheduled_sessions add column if not exists watch_pushed_at timestamptz;
alter table scheduled_sessions add column if not exists watch_pushed_sig text;
