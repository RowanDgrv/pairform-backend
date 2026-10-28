-- =============================================================================
--  0078 — Mesure d'audience exemptée de consentement (28/10/2026)
--
--  La table pageviews (0040) ne recevait que les visiteurs ayant accepté la
--  catégorie « mesure d'audience » : quelques visites sur des dizaines, sans
--  source, sans clic, sans notion de visiteur. La mesure passe sous le régime
--  d'exemption CNIL (art. 82 loi Informatique et Libertés) : finalité limitée
--  à la mesure d'audience du site pour le seul éditeur, statistiques anonymes,
--  aucun suivi inter-sites, aucun croisement, aucune transmission à un tiers,
--  données conservées 25 mois au plus, droit d'opposition (refus dans le
--  bandeau = rien n'est envoyé).
--
--  Nouvelles colonnes, toutes non personnelles :
--    event     'view' (page vue), 'scroll' (profondeur lue), 'click', 'signup'…
--    label     libellé technique de l'élément (clé i18n du bouton, chemin du
--              lien, palier de lecture « 50 »…), jamais du texte saisi
--    visit_id  identifiant ALÉATOIRE d'une visite, vit le temps de l'onglet
--              (sessionStorage) : compte des visites, pas des personnes
--    src       source déclarée dans le lien (?src=linkedin), liste fermée de
--              caractères, jamais la query string complète
-- =============================================================================

alter table public.pageviews
  add column if not exists event    text not null default 'view',
  add column if not exists label    text,
  add column if not exists visit_id text,
  add column if not exists src      text;

create index if not exists pageviews_visit_idx on public.pageviews (visit_id);

-- Conservation : 25 mois maximum (recommandation CNIL pour la mesure exemptée).
select cron.unschedule(jobid) from cron.job where jobname = 'sillance-purge-pageviews';
select cron.schedule(
  'sillance-purge-pageviews',
  '35 4 * * *',
  $$delete from public.pageviews where created_at < now() - interval '25 months'$$
);
