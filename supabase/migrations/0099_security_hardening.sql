-- =============================================================================
--  0099 — Durcissement sécurité (audit du 16/11/2026)
--
--  1. Les vues active_subscriptions / active_coaching_subscriptions /
--     active_club_memberships s'exécutaient avec les droits de leur
--     propriétaire (pas de security_invoker) : elles contournaient la RLS et
--     étaient lisibles par le rôle anon. Vérifié : la clé publique du site
--     permettait de lister les abonnements actifs (user_id, plan, ids Stripe,
--     liens coach-athlète). Aucun code ne les utilise.
--  2. Un membre de club pouvait passer lui-même `paid = true` sur son
--     inscription à un créneau payant (politique « member self manages own »
--     sans restriction de colonne).
--  3. Un utilisateur pouvait modifier lui-même des colonnes sensibles de son
--     profil (role, identifiants Stripe, staff). L'app ne les modifie jamais
--     depuis le navigateur : seules les fonctions serveur (service_role) le font.
-- =============================================================================

-- 1. Vues : respectent la RLS de l'appelant, et plus aucun accès anonyme ------
alter view public.active_subscriptions          set (security_invoker = true);
alter view public.active_coaching_subscriptions set (security_invoker = true);
alter view public.active_club_memberships       set (security_invoker = true);
revoke all on public.active_subscriptions          from anon;
revoke all on public.active_coaching_subscriptions from anon;
revoke all on public.active_club_memberships       from anon;

-- 2. Champs de paiement des créneaux : modifiables seulement par le serveur
--    (webhook Stripe) ou par le gérant du club --------------------------------
create or replace function public.guard_attendee_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from creneaux c where c.id = new.creneau_id and owns_club(c.club_id)) then
    if tg_op = 'INSERT' then
      new.paid := false; new.stripe_session_id := null; new.amount := null;
    else
      new.paid := old.paid; new.stripe_session_id := old.stripe_session_id; new.amount := old.amount;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_attendee_payment on creneau_attendees;
create trigger trg_guard_attendee_payment
  before insert or update on creneau_attendees
  for each row execute function public.guard_attendee_payment();

-- 3. Colonnes sensibles du profil : figées pour l'utilisateur lui-même --------
create or replace function public.guard_profile_sensitive()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(auth.role(), '') <> 'service_role' then
    new.role               := old.role;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_account_id  := old.stripe_account_id;
    new.charges_enabled    := old.charges_enabled;
    new.staff              := old.staff;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_profile_sensitive on profiles;
create trigger trg_guard_profile_sensitive
  before update on profiles
  for each row execute function public.guard_profile_sensitive();
