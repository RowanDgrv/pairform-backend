-- =============================================================================
--  0090 — Réponse de présence aux sorties du club (04/11/2026, demande Rowan)
--
--  creneau_attendees ne savait dire que « inscrit » (ligne présente) ou rien.
--  Désormais chaque ligne porte une réponse :
--    status   'yes' (je viens) | 'no' (pas cette fois)
--    for_date date de la séance visée ; NULL = inscription permanente
--             (lignes existantes, inscriptions posées par le coach).
--  Côté app : réponse valable pour la prochaine séance seulement ; la semaine
--  suivante l'athlète repasse « présence non confirmée ». La RLS existante
--  (« attendees: member self manages own », 0058) couvre ces colonnes.
-- =============================================================================
alter table public.creneau_attendees
  add column if not exists status   text not null default 'yes' check (status in ('yes','no')),
  add column if not exists for_date date;
