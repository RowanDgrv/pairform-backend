-- =============================================================================
--  0012_gear.sql — Matériel de l'athlète (usure chaussures + vélos)
--
--  L'athlète suit le kilométrage de ses chaussures de course et de ses vélos.
--  Des alertes se déclenchent aux paliers (chaussures : 500 / 800 / 1000 km)
--  pour anticiper le remplacement avant que l'amorti ne se dégrade.
--
--  Modèle applicatif (sillance-app.html → const GEAR) :
--    { id, type:'shoe'|'bike', name, km, max, notified:[paliers déjà notifiés] }
--  On y ajoute brand (marque, optionnel) et retired (archivage sans perdre
--  l'historique).
--
--  RLS : l'athlète gère SON matériel ; le coach lié le lit (is_coach_of).
--  Idempotent (re-jouable) : create if not exists + drop policy if exists.
-- =============================================================================

create table if not exists gear (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  type        text not null default 'shoe' check (type in ('shoe', 'bike')),
  name        text not null,
  brand       text,
  km          numeric not null default 0     check (km >= 0),
  max_km      numeric not null default 1000  check (max_km > 0),
  notified    int[]   not null default '{}', -- paliers km déjà notifiés (ex {500,800})
  retired     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists gear_athlete_idx on gear(athlete_id);

-- updated_at auto (réutilise la fonction partagée) ----------------------------
drop trigger if exists gear_touch on gear;
create trigger gear_touch before update on gear
  for each row execute function touch_updated_at();

-- RLS -------------------------------------------------------------------------
alter table gear enable row level security;

-- L'athlète gère (CRUD) son propre matériel.
drop policy if exists gear_owner_all on gear;
create policy gear_owner_all on gear
  for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());

-- Le coach lié lit le matériel de ses athlètes (lecture seule).
drop policy if exists gear_coach_read on gear;
create policy gear_coach_read on gear
  for select using (is_coach_of(athlete_id));
