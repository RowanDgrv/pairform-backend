-- =============================================================================
--  0077 — Alerte coach « séances manquées » (28/10/2026)
--
--  Le coach est prévenu quand un athlète enchaîne N séances prévues non
--  réalisées (N choisi par le coach, 2 par défaut, NULL = alerte coupée).
--  Une séance compte comme réalisée si elle est validée (done) OU si une
--  activité montre de la même famille de sport existe le même jour : en base,
--  « done » n'est posé que par la validation manuelle, le rapprochement montre
--  ne vivait que dans l'app (linkRealisedToPlan).
--
--  Une seule alerte par série de séances manquées (clé = date de la première
--  séance manquée de la série) : pas de relance quotidienne tant que la série
--  continue, nouvelle alerte seulement après une séance réalisée puis une
--  nouvelle série.
--
--  Le job pg_cron réutilise la commande du job « sillance-coach-week-reminder »
--  (même secret x-cron-secret) : le secret n'apparaît pas dans ce fichier.
-- =============================================================================

alter table public.profiles
  add column if not exists missed_alert_threshold smallint default 2
    check (missed_alert_threshold is null or missed_alert_threshold between 1 and 7),
  add column if not exists missed_alert_channel text not null default 'email'
    check (missed_alert_channel in ('email', 'push', 'both'));

create table if not exists public.coach_missed_alerts_sent (
  coach_id     uuid not null references public.profiles(id) on delete cascade,
  athlete_id   uuid not null references public.profiles(id) on delete cascade,
  streak_start date not null,
  missed_count smallint not null,
  sent_at      timestamptz not null default now(),
  primary key (coach_id, athlete_id, streak_start)
);
alter table public.coach_missed_alerts_sent enable row level security;
-- Aucune policy : table interne, lue/écrite uniquement par la fonction (service role).

-- Job horaire (h:05) ; la fonction n'envoie qu'à 9 h, heure de Paris.
select cron.unschedule(jobid) from cron.job where jobname = 'sillance-coach-missed-alert';
select cron.schedule(
  'sillance-coach-missed-alert',
  '5 * * * *',
  (select replace(command, '/functions/v1/coach-week-reminder', '/functions/v1/coach-missed-alert')
     from cron.job where jobname = 'sillance-coach-week-reminder')
);
