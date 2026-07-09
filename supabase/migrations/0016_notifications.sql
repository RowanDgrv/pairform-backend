-- =============================================================================
--  0016 — Notification du matin (récap séances + matériel)
--  ---------------------------------------------------------------------------
--  L'athlète choisit son heure et son canal (email / push / les deux).
--  Les abonnements Web Push (navigateur) sont stockés par appareil.
--  L'envoi est fait par l'edge function `morning-digest`, déclenchée toutes
--  les 15 minutes par pg_cron (voir bloc cron en bas, exécuté séparément).
-- =============================================================================

-- ---- Préférences par utilisateur ------------------------------------------
create table if not exists notification_prefs (
  user_id      uuid primary key references profiles(id) on delete cascade,
  send_hour    smallint not null default 7  check (send_hour between 0 and 23),
  send_minute  smallint not null default 0  check (send_minute in (0,15,30,45)),
  tz           text not null default 'Europe/Paris',
  channel      text not null default 'push' check (channel in ('email','push','both','none')),
  last_sent_on date,
  updated_at   timestamptz not null default now()
);
alter table notification_prefs enable row level security;
drop policy if exists "notif_prefs owner" on notification_prefs;
create policy "notif_prefs owner" on notification_prefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- Abonnements Web Push (un par navigateur/appareil) ---------------------
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
drop policy if exists "push_subs owner" on push_subscriptions;
create policy "push_subs owner" on push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists idx_push_subs_user on push_subscriptions(user_id);
