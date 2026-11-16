-- =============================================================================
--  0100 — Plafond d'appels IA par coach et par jour (audit du 16/11/2026)
--  Les réponses déjà calculées sont servies depuis le cache et ne comptent
--  pas. Seuls les vrais appels au fournisseur d'IA incrémentent le compteur.
--  But : qu'une boucle (bug ou abus avec force=true) ne puisse pas vider le
--  quota gratuit ni faire grimper la facture du fournisseur payant de repli.
-- =============================================================================
create table if not exists ai_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  n       integer not null default 0,
  primary key (user_id, day)
);
alter table ai_usage enable row level security;   -- aucune politique : serveur uniquement

-- Incrémente et dit si l'appel est autorisé (atomique).
create or replace function public.ai_usage_bump(uid uuid, max_per_day integer default 150)
returns boolean language plpgsql security definer set search_path = public as $$
declare cur integer;
begin
  insert into ai_usage (user_id, day, n) values (uid, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set n = ai_usage.n + 1
  returning n into cur;
  return cur <= max_per_day;
end $$;
revoke all on function public.ai_usage_bump(uuid, integer) from public, anon, authenticated;
grant execute on function public.ai_usage_bump(uuid, integer) to service_role;
