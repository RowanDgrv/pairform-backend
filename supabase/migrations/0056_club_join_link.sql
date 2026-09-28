-- =============================================================================
--  0056_club_join_link.sql
--  Le VRAI besoin (retour Rowan 28/09/2026, capture d'écran de l'onglet Club
--  → Adhérents) : un lien STABLE par club, partagé une fois à tous les
--  athlètes ("Partage ce lien à TES athlètes"), qui atterrissent sur une
--  demande d'adhésion que le gérant approuve/refuse et affecte à un groupe.
--  Ce n'est PAS le même besoin que club_invitations (0055, qui est un lien
--  À USAGE UNIQUE réservé à un email précis) — les deux widgets coexistent
--  dans l'app, celui-ci correspond à l'onglet Club → Adhérents.
--
--  L'UI (inviteLink/inviteWhatsapp/inviteSimulate, sillance-app.html) existait
--  déjà mais tournait à 100% sur une valeur codée en dur + un tableau JS
--  local (JOIN_REQUESTS) : rien n'était jamais parti nulle part, cf. capture
--  montrant /rejoindre/muret-goat-squad, une route qui n'a jamais existé.
-- =============================================================================

-- ---- lien stable par club (généré une fois, jamais changé sauf régénération explicite) ----
alter table clubs
  add column if not exists join_token text unique default encode(gen_random_bytes(8), 'hex');

-- ---- lecture minimale ANONYME du club par token, pour la page d'atterrissage
--      du lien (avant que le visiteur ait un compte / soit membre) ----------
create or replace function club_by_join_token(p_token text)
returns table(id uuid, name text) language sql security definer stable set search_path = public as $$
  select id, name from clubs where join_token = p_token;
$$;

-- ---- demandes d'adhésion reçues via ce lien --------------------------------
create table if not exists club_join_requests (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references clubs(id) on delete cascade,
  athlete_id  uuid not null references profiles(id) on delete cascade,
  disc        discipline,
  message     text,
  status      text not null default 'pending',   -- pending | accepted | rejected
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  unique (club_id, athlete_id)
);
create index if not exists idx_cjr_club on club_join_requests(club_id);
create index if not exists idx_cjr_athlete on club_join_requests(athlete_id);

alter table club_join_requests enable row level security;

-- Le demandeur crée/lit/annule sa propre demande (doit être connecté :
-- athlete_id = auth.uid(), pas de soumission anonyme).
drop policy if exists "cjr: requester manages own" on club_join_requests;
create policy "cjr: requester manages own" on club_join_requests
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());

-- Le gérant du club lit/traite (accepte/refuse) les demandes de son club.
drop policy if exists "cjr: owner manages" on club_join_requests;
create policy "cjr: owner manages" on club_join_requests
  for all using (owns_club(club_id)) with check (owns_club(club_id));
