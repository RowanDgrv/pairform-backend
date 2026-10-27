-- =============================================================================
--  0070 — Rappel du matin activé par défaut (email) pour tout nouvel athlète
--
--  Constat 27/10/2026 : notification_prefs était vide en prod → 0 athlète sur 6
--  ne recevait le rappel du matin, car il fallait l'activer à la main dans
--  l'espace athlète. Désormais chaque profil athlète reçoit une ligne
--  notification_prefs (email, 07:00, Europe/Paris) à sa création, ou quand
--  son rôle passe à 'athlete'. L'athlète garde la main : il change l'heure,
--  le canal ou coupe ('none') depuis son espace — `on conflict do nothing`
--  ne réécrit jamais un choix existant.
--  Les athlètes déjà inscrits ne sont PAS concernés (pas de rétro-remplissage).
-- =============================================================================

create or replace function public.default_notification_prefs()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.role = 'athlete' then
    insert into public.notification_prefs (user_id, send_hour, send_minute, tz, channel)
    values (new.id, 7, 0, 'Europe/Paris', 'email')
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists profiles_default_notification_prefs on public.profiles;
create trigger profiles_default_notification_prefs
  after insert or update of role on public.profiles
  for each row execute function public.default_notification_prefs();
