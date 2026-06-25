-- =============================================================================
--  PairForm — Migration 0004 : fonction de données démo à la demande.
--  Usage : une fois inscrit/connecté, lance dans le SQL Editor :
--      select seed_demo(auth.uid());
--  Remplit, pour CET utilisateur, des données de test couvrant les 3 rôles
--  (athlète : refs/records/check-in/séances ; coach : 1 template ; club : club
--  "Muret Goat Squad" + groupes + créneaux). Idempotent-ish (nettoie d'abord).
-- =============================================================================
create or replace function seed_demo(p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_club  uuid;
  v_g_tri uuid;
  v_g_hyrox uuid;
  v_member uuid;
  d date := current_date;
begin
  -- --- ATHLÈTE : refs physiologiques (ATHLETE_REF) ---
  insert into athlete_profiles (user_id, ftp, pma, cp_bike, vma, cv, seuil_run, css, fc_max, fc_repos)
  values (p_user, 310, 415, 300, 20.3, 18.4, 210, 98, 190, 47)
  on conflict (user_id) do update set
    ftp=excluded.ftp, pma=excluded.pma, vma=excluded.vma, css=excluded.css;

  -- --- ATHLÈTE : records (RECORDS) ---
  delete from records where athlete_id = p_user;
  insert into records (athlete_id, label, value, is_new) values
    (p_user, '10 km', '31:45', true),
    (p_user, 'Semi',  '1:08:52', true),
    (p_user, 'FTP',   '310 W', false),
    (p_user, 'PMA',   '415 W', false);

  -- --- ATHLÈTE : check-in du jour ---
  insert into checkins (athlete_id, date, sommeil, fatigue, motivation, readiness)
  values (p_user, d, 7, 4, 8, 73)
  on conflict (athlete_id, date) do update set
    sommeil=excluded.sommeil, fatigue=excluded.fatigue,
    motivation=excluded.motivation, readiness=excluded.readiness;

  -- --- ATHLÈTE : quelques séances planifiées cette semaine ---
  delete from scheduled_sessions where athlete_id = p_user and date between d and d+6;
  insert into scheduled_sessions (athlete_id, created_by, date, disc, title, dur, dist, tss, zone, done, rpe) values
    (p_user, p_user, d,     'run',  'Footing',                 45, 8.5, 42, 'Z2', false, null),
    (p_user, p_user, d+1,   'bike', 'Endurance fondamentale',  90, 33,  70, 'Z2', false, null),
    (p_user, p_user, d+2,   'swim', 'Technique natation',      60, 0,   45, 'Z2', false, null),
    (p_user, p_user, d+3,   'bike', 'Seuil 3x12''',            75, 28,  85, 'Z4', false, null),
    (p_user, p_user, d+5,   'hyrox','Hyrox — simulation',      75, 8,   90, 'Z4', false, null);

  -- --- COACH : 1 modèle de séance dans la bibliothèque ---
  delete from sessions where owner_id = p_user and title = 'Seuil vélo 3x12''';
  insert into sessions (owner_id, disc, title, dur, dist, tss, zone, active_refs, blocks, is_template)
  values (p_user, 'bike', 'Seuil vélo 3x12''', 75, 28, 85, 'Z4',
          array['ftp','fc','rpe'],
          '[{"title":"Échauffement","series":1},{"title":"3x12 min @ FTP","series":3},{"title":"Retour au calme","series":1}]'::jsonb,
          true);

  -- --- CLUB : "Muret Goat Squad" + groupes + membres + créneaux ---
  delete from clubs where owner_id = p_user and name = 'Muret Goat Squad';
  insert into clubs (name, owner_id) values ('Muret Goat Squad', p_user) returning id into v_club;

  insert into club_groups (club_id, name, color, description)
  values (v_club, 'Adultes Triathlon Half', '#9D7BFF', 'Préparation 70.3') returning id into v_g_tri;
  insert into club_groups (club_id, name, color, description)
  values (v_club, 'Hyrox', '#FF8A3D', 'Préparation et compétition Hyrox') returning id into v_g_hyrox;

  insert into club_members (club_id, athlete_id, display_name, disc, since, group_id, role) values
    (v_club, null, 'Romain Dubois', 'tri',   '2023', v_g_tri,   'member'),
    (v_club, null, 'Léa Martin',    'tri',   '2024', v_g_tri,   'member'),
    (v_club, null, 'Karim Benali',  'hyrox', '2025', v_g_hyrox, 'member')
  returning id into v_member; -- garde le dernier id (Karim) pour un créneau démo

  insert into creneaux (club_id, disc, title, day, time, dur, place, cap, coach, price, group_id) values
    (v_club, 'run',   'Séance piste collective', 1, '18:30', 90, 'Stade Nelson Paillou, Muret', 24, 'Éric',  0,  v_g_tri),
    (v_club, 'swim',  'Technique natation',      2, '12:15', 60, 'Piscine Nakache, Muret',      16, 'Julie', 0,  v_g_tri),
    (v_club, 'hyrox', 'Hyrox — simulation',      5, '19:00', 75, 'Box Hyrox Muret',             12, 'Karim', 15, v_g_hyrox);

  -- Les 3 formules du club démo (15 / 59 / 119 €) — cf. 0006_club_billing.
  insert into club_offers (club_id, tier, price, bill_interval) values
    (v_club, 'dropin', 15,  'one_time'),
    (v_club, 'sub',    59,  'month'),
    (v_club, 'coach',  119, 'month')
  on conflict (club_id, tier) do nothing;

  return 'Données démo créées pour ' || p_user || ' (club: ' || v_club || ').';
end $$;

-- Permet à un utilisateur connecté d'appeler la fonction.
grant execute on function seed_demo(uuid) to authenticated;
