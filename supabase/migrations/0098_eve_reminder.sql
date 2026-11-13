-- =============================================================================
--  0098 : rappel de la veille (13/11/2026)
--  Option de l'athlète : en plus du rappel du matin, un message la veille au soir
--  à l'heure de son choix (« C'est prévu pour demain : … Prépare ton sac : … »).
--  Même canal que le rappel du matin (email, push ou les deux).
-- =============================================================================
alter table notification_prefs add column if not exists eve_enabled boolean not null default false;
alter table notification_prefs add column if not exists eve_hour smallint not null default 21 check (eve_hour between 0 and 23);
alter table notification_prefs add column if not exists eve_minute smallint not null default 0 check (eve_minute in (0, 15, 30, 45));
alter table notification_prefs add column if not exists eve_last_sent_on date;
