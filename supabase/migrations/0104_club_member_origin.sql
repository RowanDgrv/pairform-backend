-- =============================================================================
-- 0104 — Origine de chaque adhérent d'un club : qui l'a fait entrer, comment
-- (17/11/2026, demande Rowan : « l'origine de qui l'a amené dans le club, le
-- jour, etc. dans l'outil de gestion »)
--
-- club_members.added_by    : qui a créé l'adhésion (défaut : l'utilisateur
--                            connecté qui insère ; posé explicitement par
--                            accept-club-invite = l'auteur de l'invitation)
-- club_members.join_method : 'invitation' (mail d'invitation accepté),
--                            'lien' (demande via le lien du club, acceptée),
--                            'ajout' (ajouté à la main par le staff)
-- Le jour = club_members.created_at (déjà là).
--
-- Reprise : invitation acceptée rattachée au membre → 'invitation' + invited_by ;
-- demande d'adhésion acceptée pour ce club et cet athlète → 'lien' + gérant ;
-- sinon 'ajout' (auteur inconnu : laissé vide plutôt qu'inventé).
-- =============================================================================
alter table club_members add column if not exists added_by uuid references profiles(id) on delete set null default auth.uid();
alter table club_members add column if not exists join_method text not null default 'ajout'
  check (join_method in ('invitation','lien','ajout'));

update club_members m set join_method = 'invitation', added_by = coalesce(m.added_by, i.invited_by)
from club_invitations i where i.member_id = m.id and i.status = 'accepted';

update club_members m set join_method = 'lien', added_by = coalesce(m.added_by, c.owner_id)
from club_join_requests r join clubs c on c.id = r.club_id
where r.club_id = m.club_id and r.athlete_id = m.athlete_id and r.status = 'accepted'
  and m.join_method = 'ajout';
