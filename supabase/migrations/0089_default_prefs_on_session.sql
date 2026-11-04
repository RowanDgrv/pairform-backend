-- =============================================================================
--  0089 — Rappel du matin activé dès qu'on reçoit une séance (04/11/2026)
--
--  Constat 04/11/2026 : aucun rappel du matin n'est jamais parti. Les 6 inscrits
--  (0070 + activation du 27/10) n'ont aucune séance ; le seul utilisateur ayant
--  des séances à venir (un coach qui se programme lui-même) n'avait pas de
--  ligne notification_prefs, car 0070 ne visait que les profils role='athlete'
--  à leur création.
--
--  Règle : toute personne qui reçoit une séance programmée a le rappel du
--  matin par email (07:00, Europe/Paris), sauf si elle a déjà une ligne :
--  `on conflict do nothing` ne réécrit jamais un choix existant, et le canal
--  'none' (coupé depuis l'espace athlète) reste coupé.
--  Rétro-remplissage : les personnes ayant au moins une séance à venir.
-- =============================================================================

create or replace function public.default_prefs_on_session()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.notification_prefs (user_id, send_hour, send_minute, tz, channel)
  values (new.athlete_id, 7, 0, 'Europe/Paris', 'email')
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists scheduled_sessions_default_prefs on public.scheduled_sessions;
create trigger scheduled_sessions_default_prefs
  after insert on public.scheduled_sessions
  for each row execute function public.default_prefs_on_session();

insert into public.notification_prefs (user_id, send_hour, send_minute, tz, channel)
select distinct s.athlete_id, 7, 0, 'Europe/Paris', 'email'
from public.scheduled_sessions s
where s.date >= current_date
on conflict (user_id) do nothing;
