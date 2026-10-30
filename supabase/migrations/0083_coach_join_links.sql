-- =============================================================================
--  0083 — Lien d'équipe du coach : UN lien réutilisable pour tous ses athlètes
--  (30/10/2026)
--
--  Avant : une invitation par email, à usage unique, refusée si l'athlète
--  s'inscrivait avec une autre adresse. Maintenant le coach partage un seul
--  lien (?coach=<token>, WhatsApp, groupe du club…) ; chaque athlète crée son
--  compte avec SON prénom et SON nom (formulaire d'inscription) puis est relié
--  au coach par l'edge function join-coach.
--
--  Le lien ne porte AUCUN nom : c'est le bug du club Muret Triathlon
--  (15/10/2026) — un nom attaché à un lien partagé, recopié sur chaque
--  membre, primait sur le vrai nom de chacun. Ici le nom affiché vient
--  uniquement du profil de l'athlète.
--  Régénérer le lien (nouveau token) désactive l'ancien.
-- =============================================================================
create table if not exists public.coach_join_links (
  coach_id   uuid primary key references public.profiles(id) on delete cascade,
  token      text not null unique default encode(gen_random_bytes(12), 'hex'),
  created_at timestamptz not null default now()
);
alter table public.coach_join_links enable row level security;
drop policy if exists "coach_join_links: own" on public.coach_join_links;
create policy "coach_join_links: own" on public.coach_join_links
  for all using (coach_id = auth.uid()) with check (coach_id = auth.uid());
