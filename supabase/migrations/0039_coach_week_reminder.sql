-- =============================================================================
--  0039 — Rappel de planification coach + notif "semaine prête"
--  ---------------------------------------------------------------------------
--  Spec complète : ~/sillance-docs-prives/SPEC-RAPPEL-PLANIF-COACH.md
--
--  - profiles.week_deadline_day : jour choisi par le coach (vendredi/samedi/
--    dimanche) où sa semaine de planification doit être bouclée. Les 3
--    rappels (H-72/H-48/H-24, edge function coach-week-reminder) sont
--    comptés à rebours depuis CE jour, pas un jour fixe.
--  - coach_athlete.planning_horizon_weeks : combien de semaines à l'avance
--    l'athlète voit son planning (réglage par athlète, pas global au coach).
--  - coach_week_reminders_sent : dédup des 3 checkpoints par coach/semaine,
--    pour ne pas renvoyer 2x le même push si la fonction cron tourne
--    plusieurs fois dans la fenêtre de 15 min.
-- =============================================================================

alter table profiles
  add column if not exists week_deadline_day text
    check (week_deadline_day in ('friday','saturday','sunday'));

alter table coach_athlete
  add column if not exists planning_horizon_weeks smallint
    not null default 1 check (planning_horizon_weeks in (1,2));

create table if not exists coach_week_reminders_sent (
  coach_id     uuid not null references profiles(id) on delete cascade,
  week_monday  date not null,          -- semaine cible (celle qui suit le jour deadline)
  checkpoint   text not null check (checkpoint in ('h72','h48','h24')),
  sent_at      timestamptz not null default now(),
  primary key (coach_id, week_monday, checkpoint)
);
alter table coach_week_reminders_sent enable row level security;
drop policy if exists "coach reads own reminders" on coach_week_reminders_sent;
create policy "coach reads own reminders" on coach_week_reminders_sent
  for select using (coach_id = auth.uid());
-- écriture : service_role uniquement (edge function coach-week-reminder), pas de policy INSERT/UPDATE cliente.
