-- =============================================================================
--  0041 — Verrouille role/stripe_account_id/charges_enabled contre le client
--  ---------------------------------------------------------------------------
--  Audit sécurité du 23-24/08/2026 (Claude) : les policies "profiles: self
--  update" (0001) et "clubs: owner all" (0001) autorisent l'UPDATE de
--  N'IMPORTE QUELLE colonne dès lors que la ligne appartient à l'appelant.
--  Or `stripe_account_id`/`charges_enabled` (ajoutées en 0006/0007, avec un
--  commentaire disant explicitement qu'elles sont "mises à jour par le
--  webhook") et `profiles.role` n'ont jamais été protégées au niveau colonne.
--
--  Exploit confirmé en lecture de code (pas testé en live, pas de token) :
--    supabase.from('profiles').update({role:'coach'}).eq('id', monId)
--    supabase.from('profiles').update({stripe_account_id:'acct_ATTAQUANT',
--      charges_enabled:true}).eq('id', monId)
--    supabase.from('clubs').update({stripe_account_id:'acct_ATTAQUANT',
--      charges_enabled:true}).eq('id', monClubId)
--  Le 2e cas redirige de l'argent réel (transfer_data.destination dans
--  coach-subscribe/club-subscribe) vers un compte Stripe arbitraire. Le 1er
--  permet à un athlète de devenir "coach" gratuitement et, si un vrai
--  athlète accepte une invitation de sa part, de lire ses données de santé
--  via les policies "coach reads" existantes (is_coach_of).
--
--  Fix : trigger BEFORE UPDATE qui rejette tout changement de ces colonnes
--  sauf si l'appelant EST le service_role (edge functions/webhook) — c'est
--  le seul acteur légitime pour ces 3 colonnes. RLS reste inchangée pour
--  tout le reste (full_name, avatar_url, email, name... toujours éditables).
-- =============================================================================

create or replace function guard_sensitive_profile_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'service_role' then
    if new.role is distinct from old.role then
      raise exception 'Modification du rôle non autorisée depuis le client.';
    end if;
    if new.stripe_account_id is distinct from old.stripe_account_id then
      raise exception 'Modification de stripe_account_id non autorisée depuis le client.';
    end if;
    if new.charges_enabled is distinct from old.charges_enabled then
      raise exception 'Modification de charges_enabled non autorisée depuis le client.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sensitive_profile_columns on profiles;
create trigger trg_guard_sensitive_profile_columns
  before update on profiles
  for each row execute function guard_sensitive_profile_columns();

create or replace function guard_sensitive_club_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'service_role' then
    if new.stripe_account_id is distinct from old.stripe_account_id then
      raise exception 'Modification de stripe_account_id non autorisée depuis le client.';
    end if;
    if new.charges_enabled is distinct from old.charges_enabled then
      raise exception 'Modification de charges_enabled non autorisée depuis le client.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sensitive_club_columns on clubs;
create trigger trg_guard_sensitive_club_columns
  before update on clubs
  for each row execute function guard_sensitive_club_columns();
