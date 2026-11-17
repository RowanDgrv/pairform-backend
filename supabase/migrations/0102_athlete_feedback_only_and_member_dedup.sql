-- =============================================================================
-- 0102 — (1) L'athlète ne modifie que SON RETOUR sur une séance programmée par
--            un autre ; (2) un adhérent ne peut plus figurer deux fois dans un club
-- (17/11/2026, demande Rowan)
--
-- (1) La policy « sched: athlete updates own (done/rpe) » (0001) laissait l'athlète
--     modifier TOUTES les colonnes de ses séances (titre, durée, contenu, date…),
--     y compris celles de son coach perso ou du club. Une policy RLS ne peut pas
--     limiter des colonnes selon la ligne : on garde la policy et on ajoute un
--     trigger BEFORE UPDATE. Sur une séance qui n'est pas la sienne, l'athlète ne
--     peut changer que : done, rpe, rpe_muscle, strength_log (+ watch_pushed_*,
--     posés par le serveur). Sa propre séance en autonomie : inchangé, tout est
--     permis. Les coachs / le staff passent par leurs propres règles (0101).
--     Le serveur (service_role, auth.uid() nul) n'est pas concerné.
--
-- (2) AS Muret Triathlon : un adhérent avait 3 lignes club_members (créées le
--     28-29/09 ; aucune présence, paiement, adhésion ni invitation attachée aux
--     doublons). Cause probable : resolveJoinRequest insérait sans vérifier, et
--     accept-club-invite ne détectait pas un doublon déjà présent (maybeSingle
--     en erreur sur 2 lignes → nouvelle insertion). On garde la ligne la plus
--     ancienne, on y rattache ce qui pointerait vers les autres, on supprime les
--     doublons, puis un index unique empêche toute récidive.
--
-- Appliquer : npx supabase db query --linked -f <ce fichier>   (JAMAIS db push)
-- =============================================================================

-- ---- (1) retour de l'athlète seulement --------------------------------------
create or replace function sched_athlete_feedback_only() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  allowed text[] := array['done','rpe','rpe_muscle','strength_log','watch_pushed_at','watch_pushed_sig'];
begin
  if uid is null or uid <> old.athlete_id then return new; end if;        -- serveur, ou coach/staff (leurs règles)
  if club_staff_for(old.club_id, old.athlete_id) then return new; end if; -- athlète qui est aussi staff de ce club
  if old.club_id is null and old.source_creneau_id is null
     and (old.created_by = uid or old.created_by is null) then return new; end if;   -- sa séance en autonomie
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'Sur une séance programmée par ton coach ou ton club, seul ton retour (fait, RPE, carnet) est modifiable'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists scheduled_sessions_athlete_feedback_only on scheduled_sessions;
create trigger scheduled_sessions_athlete_feedback_only
  before update on scheduled_sessions
  for each row execute function sched_athlete_feedback_only();

-- ---- (2) doublons d'adhérents -----------------------------------------------
create temp table _dups on commit drop as
select m.id dup, k.keep from club_members m
join lateral (
  select id keep from club_members k
  where k.club_id = m.club_id and k.athlete_id = m.athlete_id
  order by k.created_at, k.id limit 1
) k on true
where m.athlete_id is not null and m.id <> k.keep;

-- rattacher ce qui pointerait vers un doublon (rien à Muret, mais par sécurité)
delete from creneau_attendees a using _dups d
 where a.athlete_id = d.dup
   and exists (select 1 from creneau_attendees b where b.creneau_id = a.creneau_id and b.athlete_id = d.keep);
update creneau_attendees a set athlete_id = d.keep from _dups d where a.athlete_id = d.dup;
update creneau_payments  x set member_id  = d.keep from _dups d where x.member_id  = d.dup;
update club_memberships  x set member_id  = d.keep from _dups d where x.member_id  = d.dup;
update club_invitations  x set member_id  = d.keep from _dups d where x.member_id  = d.dup;
delete from club_members m using _dups d where m.id = d.dup;

create unique index if not exists club_members_one_per_athlete
  on club_members (club_id, athlete_id) where athlete_id is not null;

-- ---- (3) suppression par l'athlète ------------------------------------------
-- « sched: athlete deletes own » laissait l'athlète supprimer les séances de son
-- coach ou du club. Il garde : ses séances en autonomie, et les séances de
-- créneau (l'app les retire quand il se désinscrit d'un créneau).
drop policy if exists "sched: athlete deletes own" on scheduled_sessions;
create policy "sched: athlete deletes own" on scheduled_sessions
  for delete using (
    athlete_id = auth.uid() and (
      source_creneau_id is not null
      or (club_id is null and (created_by = auth.uid() or created_by is null))
    )
  );
