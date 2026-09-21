-- Flag "fondateur" (21/09/2026) : trace qui a eu le tarif réduit "10 premiers"
-- (club solo/grand club/illimité, cf. index.html#pricing) — jusqu'ici invisible
-- en base, donc impossible de savoir combien de places restaient. Sur
-- subscriptions (pas profiles) : c'est une propriété de CET abonnement/de
-- cette offre commerciale, pas du compte en général.
alter table subscriptions add column if not exists founder boolean not null default false;
comment on column subscriptions.founder is
  'Compte "10 premiers" au tarif fondateur réduit (posé manuellement via la page admin — aucun mécanisme automatique de comptage/plafond, juste un repère visuel).';
