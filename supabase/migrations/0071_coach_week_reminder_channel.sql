-- =============================================================================
--  0071 — Rappel de planification coach : canal au choix, email par défaut
--
--  Constat 27/10/2026 : le rappel H-72/H-48/H-24 (coach-week-reminder) n'est
--  jamais parti — push uniquement, aucun coach abonné au push, et aucun
--  week_deadline_day renseigné (le sélecteur n'était pas affiché sur un vrai
--  compte). Le coach choisit désormais son canal ; 'email' par défaut, comme
--  le rappel du matin des athlètes (0070). week_deadline_day NULL est lu
--  « dimanche » par la fonction : pas de rétro-remplissage nécessaire.
-- =============================================================================

alter table public.profiles
  add column if not exists week_reminder_channel text not null default 'email'
  check (week_reminder_channel in ('email', 'push', 'both', 'none'));
