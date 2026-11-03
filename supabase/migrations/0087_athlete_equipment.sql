-- =============================================================================
--  0087 — Inventaire du matériel de l'athlète (03/11/2026)
--
--  Ce que l'athlète POSSÈDE, hors suivi d'usure (baskets/vélos restent dans
--  gear, au km) : ceinture cardio, capteur de puissance, plaquettes, palmes,
--  tuba, pull-buoy, parachute, planche, élastiques, veste de pluie…
--  item_key = clé du catalogue front (sillance-equipment.js), ou 'custom:…'
--  pour un objet libre (label).
--  Sert à : « Matériel de l'athlète » côté coach (lecture), programmer selon
--  ce matériel, et la liste « À prévoir » du jour (ex. ceinture cardio
--  ajoutée aux séances de course si l'athlète en a une).
--  RLS : l'athlète gère le sien ; son coach (suivi actif) et le staff de son
--  club le LISENT.
-- =============================================================================
create table if not exists public.athlete_equipment (
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  item_key   text not null check (char_length(item_key) between 1 and 60),
  label      text check (label is null or char_length(label) <= 60),
  created_at timestamptz not null default now(),
  primary key (athlete_id, item_key)
);
alter table public.athlete_equipment enable row level security;

drop policy if exists "equipment: own all" on public.athlete_equipment;
create policy "equipment: own all" on public.athlete_equipment
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());

drop policy if exists "equipment: coach reads" on public.athlete_equipment;
create policy "equipment: coach reads" on public.athlete_equipment
  for select using (is_coach_of(athlete_id) or club_coach_manages(athlete_id));
