-- =============================================================================
--  Seed du catalogue vidéo (repris du tableau VIDEOS de l'app).
--  src vide pour l'instant : à uploader dans Storage puis renseigner l'URL.
--  is_premium = true par défaut (réservé abonnés) ; passe à false pour la démo.
-- =============================================================================
insert into videos (disc, title, duration, level, description, tags, is_premium) values
  -- Natation
  ('swim','Crawl — rattrapé','1:24','Inter','Une main attend l''autre devant : améliore le timing et l''allonge.', array['rattrapé','rattrape'], true),
  ('swim','Crawl — poings fermés','0:58','Inter','Nager poings fermés pour sentir l''appui de l''avant-bras.', array['poings fermés','poings'], true),
  ('swim','Crawl — battements planche','1:10','Débutant','Renforce le battement et le gainage, planche devant.', array['battement','planche'], false),
  ('swim','Respiration 3 temps','1:05','Débutant','Alterner le côté de respiration pour équilibrer le crawl.', array['respiration','3 temps'], false),
  ('swim','Virage culbute','1:32','Avancé','Technique de virage rapide en bassin.', array['virage','culbute'], true),
  ('swim','Pull-buoy & plaquettes','1:18','Inter','Travail de force et de trajet moteur avec matériel.', array['plaquette','pull-buoy','pull'], true),
  -- Course
  ('run','Gammes — montées de genoux','0:48','Débutant','Éducatif de foulée, fréquence et posture.', array['gammes','montées de genoux','genoux'], false),
  ('run','Gammes — talons-fesses','0:44','Débutant','Active les ischios et le cycle arrière.', array['talons-fesses','gammes'], false),
  ('run','Foulées bondissantes','1:02','Avancé','Travail de puissance et d''élasticité.', array['bondissantes','foulées','foulee'], true),
  ('run','Lignes droites (strides)','0:55','Inter','Accélérations progressives pour la vitesse et la relâche.', array['lignes droites','strides','ligne'], true),
  -- Vélo
  ('bike','Pédalage — vélocité','1:15','Inter','Travail de cadence élevée et de fluidité du coup de pédale.', array['vélocité','cadence'], true),
  ('bike','Position aéro & posture','1:40','Inter','Optimiser sa position pour l''aérodynamisme et le confort.', array['aéro','position','posture'], true),
  ('bike','Montée en danseuse','1:08','Avancé','Technique de relance et de grimpe debout.', array['danseuse','montée','grimpe'], true)
on conflict do nothing;
