-- ---------------------------------------------------------------------------
--  0019 — Journal dispo/blessure + poids dans le check-in matinal
--  L'athlète signale sa disponibilité (ok / fatigué / malade / blessé) et une
--  note libre ("douleur mollet droit") ; le coach la voit via la policy
--  existante "checkins: coach reads". Le poids (déjà saisi côté app) devient
--  persistant → W/kg réel.
--  Le client (sillance-client.js saveCheckin) envoie ces colonnes avec repli
--  gracieux : déployer cette migration les active sans changement front.
-- ---------------------------------------------------------------------------
alter table checkins
  add column if not exists poids      numeric(5,2) check (poids between 30 and 150),
  add column if not exists dispo      text check (dispo in ('ok','fatigue','malade','blesse')),
  add column if not exists dispo_note text check (char_length(dispo_note) <= 500);
