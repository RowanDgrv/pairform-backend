-- =============================================================================
-- 0103 — Fermer deux accès ouverts à tous (17/11/2026, audit « personne ne
-- regarde un club sans y être »)
--
-- (1) seed_demo(p_user) : SECURITY DEFINER, exécutable par anon/authenticated.
--     N'importe qui (même sans compte) pouvait, avec l'id d'un utilisateur,
--     écraser ses références, SUPPRIMER ses records et injecter des données de
--     démo chez lui. Outil de remplissage manuel (SQL editor) : aucun appel
--     depuis l'app ni les fonctions → exécution retirée à tous sauf service_role.
-- (2) club_offers : « club_offers: readable » USING (true) — les offres et tarifs
--     d'un club étaient lisibles par n'importe qui. Désormais : membres du club
--     (le gérant garde « owner writes », FOR ALL).
-- =============================================================================
revoke execute on function public.seed_demo(uuid) from public, anon, authenticated;
grant execute on function public.seed_demo(uuid) to service_role;

drop policy if exists "club_offers: readable" on club_offers;
create policy "club_offers: member reads" on club_offers
  for select using (is_club_member(club_id));
