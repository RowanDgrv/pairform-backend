-- Retrait de l'alerte météo → swap séance (jugée imprécise, gadget, sans
-- intérêt réel par Rowan) : on supprime les colonnes de localisation
-- ajoutées en 0031, plus utilisées par le front.
alter table athlete_profiles drop column if exists city;
alter table athlete_profiles drop column if exists lat;
alter table athlete_profiles drop column if exists lon;
