-- =============================================================================
--  0045 — Offre "Sillance Premium" : bibliothèque de séances + Assistant IA
--  ---------------------------------------------------------------------------
--  Nouvelle offre payante pour les coachs (et pour les clubs) qui débloque :
--    • la bibliothèque de 100 séances-types course & vélo (fiches prêtes, avec
--      objectif, structure, zone cible, justification scientifique, référence) ;
--    • l'add-on Assistant IA (résumés + recommandations par séance) — inclus,
--      donc pas de double paiement avec l'add-on IA autonome (0009).
--
--  Modèle d'entitlement (miroir de ai_addons) :
--    coach_premium         = abo Premium d'un coach (écrit par le webhook Stripe).
--    clubs.premium_until    = un club a payé Premium → ses coachs/admins en
--                             héritent tant que la date court.
--    profiles.staff         = comptes Sillance (accès permanent, gratuit).
--
--  Portes :
--    has_premium(uid)        → l'utilisateur a Premium (coach OU via club OU staff).
--    has_library_access(uid) → = has_premium (nom explicite côté bibliothèque).
--    my_library_access()     → wrapper sans argument (auth.uid()) pour la RLS.
--    has_ai_addon(uid)       → étendu : vrai aussi si has_premium.
--
--  RLS : library_sessions n'est LISIBLE que si my_library_access(). Écriture =
--  service_role (seed ci-dessous + futures mises à jour de contenu).
-- =============================================================================

-- ---------------------------------------------------------------------------
--  1. profiles.staff  (comptes Sillance)
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists staff boolean not null default false;
comment on column profiles.staff is
  'Compte Sillance (équipe) : accès permanent et gratuit aux offres payantes '
  '(bibliothèque, Assistant IA). Posé à la main.';

update profiles set staff = true where lower(email) = 'rowandegraeve@gmail.com';

-- ---------------------------------------------------------------------------
--  2. coach_premium  (entitlement Premium par coach — écrit par le webhook)
-- ---------------------------------------------------------------------------
create table if not exists coach_premium (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles(id) on delete cascade,
  status                  sub_status not null default 'incomplete',
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  price_id                text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now()
);
create index if not exists idx_coach_premium_user on coach_premium(user_id);

alter table coach_premium enable row level security;

drop policy if exists coach_premium_owner_read on coach_premium;
create policy coach_premium_owner_read on coach_premium
  for select using (user_id = auth.uid());   -- écriture = service_role (webhook)

drop trigger if exists trg_coach_premium_updated on coach_premium;
create trigger trg_coach_premium_updated before update on coach_premium
  for each row execute function touch_updated_at();

comment on table coach_premium is
  'Abonnement "Sillance Premium" d''un coach. Écrit UNIQUEMENT par stripe-webhook '
  '(kind=coach_premium). "Actif ?" via has_premium().';

-- ---------------------------------------------------------------------------
--  3. clubs.premium_until  (un club a payé Premium pour son staff)
-- ---------------------------------------------------------------------------
alter table clubs add column if not exists premium_until timestamptz;
comment on column clubs.premium_until is
  'Fin de période de l''abonnement "Sillance Premium Club". Tant que > now(), '
  'le propriétaire et les membres role in (coach,admin) ont la bibliothèque + IA. '
  'Écrit par stripe-webhook (kind=club_premium).';

-- ---------------------------------------------------------------------------
--  4. Helpers d'entitlement
-- ---------------------------------------------------------------------------
create or replace function club_grants_premium(uid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from clubs c
    where c.premium_until is not null and c.premium_until > now()
      and (
        c.owner_id = uid
        or exists (
          select 1 from club_members m
          where m.club_id = c.id and m.athlete_id = uid
            and m.role in ('coach', 'admin')
        )
      )
  );
$$;

create or replace function has_premium(uid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select
    exists (select 1 from profiles p where p.id = uid and p.staff)
    or exists (
      select 1 from coach_premium cp
      where cp.user_id = uid
        and cp.status in ('active', 'trialing')
        and (cp.current_period_end is null or cp.current_period_end > now())
    )
    or club_grants_premium(uid);
$$;

create or replace function has_library_access(uid uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select has_premium(uid);
$$;

-- wrapper sans argument pour la RLS (ne révèle jamais que le statut de l'appelant)
create or replace function my_library_access()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select has_premium(auth.uid());
$$;

-- has_ai_addon : Premium inclut l'Assistant IA (pas de double paiement).
create or replace function has_ai_addon(uid uuid)
returns boolean
language sql security definer
set search_path = public
as $$
  select
    has_premium(uid)
    or exists (
      select 1 from ai_addons
      where user_id = uid
        and status in ('active', 'trialing')
        and (current_period_end is null or current_period_end > now())
    );
$$;

-- Oracle de statut : réservé aux edge functions (service_role bypass les grants).
revoke execute on function club_grants_premium(uuid) from public, anon, authenticated;
revoke execute on function has_premium(uuid)          from public, anon, authenticated;
revoke execute on function has_library_access(uuid)   from public, anon, authenticated;
revoke execute on function has_ai_addon(uuid)         from public, anon, authenticated;
-- my_library_access() reste exécutable (utilisé par la RLS, ne teste que l'appelant).

-- ---------------------------------------------------------------------------
--  5. library_sessions  (les 100 fiches officielles Sillance)
-- ---------------------------------------------------------------------------
create table if not exists library_sessions (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,          -- 'RUN-EF-01', 'BIKE-FTP-02'
  sport           text not null,                 -- 'run' | 'bike'
  disc            discipline not null,
  category        text not null,                 -- 'Endurance fondamentale', 'Seuil'…
  title           text not null,
  objective       text,
  structure       text,
  duration_label  text,                          -- '30-45 min'
  dur_min         integer,
  dur_max         integer,
  dur             integer not null default 0,    -- minutes (milieu de fourchette)
  zone_label      text,                          -- '70-78% VMA' / '56-75% FTP'
  zone_hr         text,                          -- vélo : '69-83% FCmax'
  cadence         text,                          -- vélo : '85-95'
  zone            text,                          -- Z1..Z5 normalisé (calendrier)
  rpe_low         integer,
  rpe_high        integer,
  recovery        text,
  level           text not null default 'tous',  -- tous | intermediaire | avance | intermediaire_avance
  rationale       text,
  reference       text,
  tss             integer not null default 0,    -- estimé (durée × intensité²)
  published       boolean not null default true,
  sort            integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_library_sport_cat on library_sessions(sport, category, sort);

alter table library_sessions enable row level security;

drop policy if exists library_sessions_read on library_sessions;
create policy library_sessions_read on library_sessions
  for select using (published and my_library_access());
-- écriture : service_role uniquement (contenu officiel).

comment on table library_sessions is
  'Bibliothèque officielle Sillance : 100 séances-types course & vélo. '
  'Lisible seulement par les comptes avec Premium (my_library_access). '
  'Le coach importe une fiche dans SES sessions ou la planifie directement.';

-- ---------------------------------------------------------------------------
--  6. Seed des 100 fiches  (généré depuis content/library/library.json)
-- ---------------------------------------------------------------------------
insert into library_sessions (code, sport, disc, category, title, objective, structure, duration_label, dur_min, dur_max, dur, zone_label, zone_hr, cadence, zone, rpe_low, rpe_high, recovery, level, rationale, reference, tss, sort) values
  ('RUN-EF-01', 'run', 'run', 'Endurance fondamentale', 'Footing EF court', 'Développement de la base aérobie, densité mitochondriale, économie de course', 'Course continue à allure conversationnelle', '30-45 min', 30, 45, 38, '70-78% VMA', '', '', 'Z2', 3, 4, 'Aucune (continu)', 'tous', 'Le volume en endurance fondamentale reste l''un des meilleurs prédicteurs de la performance sur toutes les distances de fond', 'Seiler 2010 ; Fokkema 2020', 31, 1),
  ('RUN-EF-02', 'run', 'run', 'Endurance fondamentale', 'Footing EF moyen', 'Développement de la base aérobie et du volume hebdomadaire', 'Course continue à allure conversationnelle', '45-70 min', 45, 70, 58, '70-78% VMA', '', '', 'Z2', 3, 4, 'Aucune (continu)', 'tous', 'idem EF-01', 'Seiler 2010', 47, 2),
  ('RUN-EF-03', 'run', 'run', 'Endurance fondamentale', 'Footing EF long', 'Développement de la base aérobie et de la résistance', 'Course continue', '70-100 min', 70, 100, 85, '70-76% VMA', '', '', 'Z2', 3, 5, 'Aucune (continu)', 'intermediaire_avance', 'Le volume et la distance des sorties sont associés à la performance marathon', 'Fokkema 2020', 69, 3),
  ('RUN-EF-04', 'run', 'run', 'Endurance fondamentale', 'EF progressif', 'Développement aérobie + transition douce vers le seuil', '2/3 en EF puis progressif jusqu''au seuil bas sur le dernier tiers', '45-60 min', 45, 60, 53, '70-88% VMA', '', '', 'Z3', 3, 6, 'Aucune (continu)', 'intermediaire_avance', 'Progression d''intensité en fin de sortie = stimulus seuil sans séance dédiée', 'Construit', 64, 4),
  ('RUN-EF-05', 'run', 'run', 'Endurance fondamentale', 'EF + gammes/éducatifs', 'Base aérobie + entretien technique de course', 'EF + 6-8 éducatifs (montées de genoux, talons-fesses, pas chassés) + 6x100m accélérations progressives', '40-50 min', 40, 50, 45, '70-78% VMA', '', '', 'Z2', 3, 4, '1 min marche entre éducatifs', 'tous', 'Les éducatifs/accélérations entretiennent le geste sans coût métabolique significatif', 'Construit', 37, 5),
  ('RUN-EF-06', 'run', 'run', 'Endurance fondamentale', 'Footing nature/dénivelé', 'Base aérobie + renforcement excentrique naturel (descentes)', 'EF sur terrain vallonné, allure adaptée à la pente', '45-75 min', 45, 75, 60, '70-82% VMA', '', '', 'Z2', 4, 6, 'Aucune', 'intermediaire_avance', 'Le dénivelé ajoute un stimulus de force fonctionnelle sans séance de muscu dédiée', 'Construit', 49, 6),
  ('RUN-SEU-01', 'run', 'run', 'Seuil', 'Seuil continu court', 'Développer la vitesse soutenable (SV2)', '15-20 min continus au seuil', '25-30 min total', 25, 30, 28, '85-90% VMA', '', '', 'Z3', 6, 7, '', 'intermediaire', 'Le travail au seuil augmente la fraction de VO2max soutenable longtemps, déterminant clé en course de fond', 'Seiler 2010 ; Billat 2001', 34, 7),
  ('RUN-SEU-02', 'run', 'run', 'Seuil', 'Seuil continu long', 'Développement prolongé de la vitesse soutenable', '25-35 min continus au seuil', '35-45 min total', 35, 45, 40, '85-90% VMA', '', '', 'Z3', 6, 7, '', 'avance', 'idem SEU-01', 'Seiler 2010', 48, 8),
  ('RUN-SEU-03', 'run', 'run', 'Seuil', 'Seuil fractionné 2x', 'Développer le seuil avec moins de fatigue qu''en continu', '2 x 15-20 min au seuil, r=3 min trot', '45-55 min total', 45, 55, 50, '85-92% VMA', '', '', 'Z4', 6, 7, '3 min trot EF', 'intermediaire_avance', 'Le fractionné permet d''accumuler plus de temps au seuil qu''en continu, à fatigue égale', 'Construit', 78, 9),
  ('RUN-SEU-04', 'run', 'run', 'Seuil', 'Cruise intervals', 'Répétitions proches du seuil avec récupération courte', '5-6 x 1000m à allure semi/seuil dur, r=1 min trot', '40-45 min total', 40, 45, 43, '88-94% VMA', '', '', 'Z4', 6, 7, '1 min trot', 'avance', 'Format popularisé par Jack Daniels pour développer le seuil sans la fatigue du continu', 'Daniels, Running Formula', 67, 10),
  ('RUN-SEU-05', 'run', 'run', 'Seuil', 'Tempo progressif', 'Développer la capacité à accélérer sur fatigue légère', '20 min progressif de l''allure EF jusqu''au seuil', '30 min total', 30, 30, 30, '78-90% VMA', '', '', 'Z3', 5, 7, '', 'intermediaire_avance', 'Simule la gestion d''allure en fin de course', 'Construit', 36, 11),
  ('RUN-SEU-06', 'run', 'run', 'Seuil', 'Seuil en côte', 'Développer le seuil + renforcement spécifique', '6-8 x 3 min en côte modérée à allure seuil, retour trot', '40-50 min total', 40, 50, 45, '85-92% VMA', '', '', 'Z4', 6, 7, 'Retour trot en descente', 'avance', 'La côte réduit l''impact au sol tout en sollicitant le seuil et la force', 'Construit', 71, 12),
  ('RUN-VO2-01', 'run', 'run', 'VO2max', '1000m x5-6', 'Développer VO2max et la vitesse aérobie maximale', '5-6 x 1000m à 100-105% VMA, r=2-3 min trot', '45-55 min total', 45, 55, 50, '100-105% VMA', '', '', 'Z5', 8, 9, '2-3 min trot', 'avance', 'Format de référence pour développer VO2max (temps passé ≥90%VO2max maximisé)', 'Billat 2001', 94, 13),
  ('RUN-VO2-02', 'run', 'run', 'VO2max', '400m x8-10', 'Stimulus VO2max plus court et plus rapide', '8-10 x 400m à 105-110% VMA, r=1-2 min trot', '40-45 min total', 40, 45, 43, '105-110% VMA', '', '', 'Z5', 8, 9, '1-2 min trot', 'avance', 'idem VO2-01, répétitions courtes = intensité plus élevée', 'Billat 2001', 81, 14),
  ('RUN-VO2-03', 'run', 'run', 'VO2max', '30/30', 'Maximiser le temps passé à VO2max avec fatigue modérée', '12-15 x 30s à 100-110% VMA / 30s récup active', '25-30 min total', 25, 30, 28, '100-110% VMA', '', '', 'Z5', 8, 9, '30s trot', 'avance', 'Le format 30/30 maximise le temps à VO2max grâce à la récupération incomplète', 'Billat 2000 (protocole 30-30)', 52, 15),
  ('RUN-VO2-04', 'run', 'run', 'VO2max', '15/15', 'Stimulus VO2max intermittent', '15-20 x 15s à 105-115% VMA / 15s récup', '20-25 min total', 20, 25, 23, '105-115% VMA', '', '', 'Z5', 8, 9, '15s trot', 'avance', 'idem VO2-03', 'Billat 2000', 43, 16),
  ('RUN-VO2-05', 'run', 'run', 'VO2max', 'Pyramide VO2max', 'Varier la durée des répétitions pour la motivation', '400-800-1200-800-400m à 100-108% VMA, r=2-3 min', '45-50 min total', 45, 50, 48, '100-108% VMA', '', '', 'Z5', 8, 9, '2-3 min trot', 'avance', 'Variante de format, même stimulus physiologique', 'Construit', 90, 17),
  ('RUN-VO2-06', 'run', 'run', 'VO2max', 'VO2max en côte courte', 'Développer VO2max avec moins d''impact', '10-12 x 300-400m en côte à effort maximal aérobie, retour trot', '40-45 min total', 40, 45, 43, '100-110% VMA', '', '', 'Z5', 8, 9, 'Retour trot', 'avance', 'La côte permet un travail VO2max avec un risque de blessure réduit', 'Construit', 81, 18),
  ('RUN-VIT-01', 'run', 'run', 'Vitesse/anaérobie', '200m répétitions', 'Puissance anaérobie et économie de course à haute vitesse', '8-10 x 200m à vitesse proche du sprint, r=2 min', '30-35 min total', 30, 35, 33, '130-150% VMA', '', '', 'Z5', 8, 9, '2 min marche/trot', 'avance', 'Stimulus neuromusculaire complémentaire, sans bénéfice direct documenté sur la perf marathon mais utile à l''économie de course', 'Construit (extrapolation)', 62, 19),
  ('RUN-VIT-02', 'run', 'run', 'Vitesse/anaérobie', 'Côtes courtes explosives', 'Puissance et recrutement musculaire', '8-10 x 10-15s en côte raide, effort maximal, retour marche complet', '25-30 min total', 25, 30, 28, '—', '', '', 'Z5', 9, 9, 'Retour marche complet', 'avance', 'Proche d''un stimulus pliométrique/neuromusculaire, similaire aux bénéfices documentés du renforcement lourd sur l''économie de course', 'RCT économie de course 2025', 52, 20),
  ('RUN-VIT-03', 'run', 'run', 'Vitesse/anaérobie', '100m x10 lignes droites', 'Entretenir la vitesse et le geste sans fatigue significative', '10 x 100m accélérations progressives, retour marche', '20-25 min total', 20, 25, 23, '—', '', '', 'Z4', 6, 7, 'Retour marche', 'tous', 'Utilisé en routine dans la majorité des plans marathon analysés', 'Analyse 92 plans marathon 2024', 36, 21),
  ('RUN-VIT-04', 'run', 'run', 'Vitesse/anaérobie', 'Éducatifs + accélérations', 'Technique de course et prévention des déséquilibres', '6-8 éducatifs + 6x80m accélérations', '20 min', 20, 20, 20, '—', '', '', 'Z3', 4, 5, '1 min marche', 'tous', 'Routine classique d''entretien technique', 'Construit', 24, 22),
  ('RUN-10K-01', 'run', 'run', 'Allure 10K', 'Continu 10K', 'Calibrer et développer l''allure 10K', '15-20 min continus à allure 10K', '25-30 min total', 25, 30, 28, '92-97% VMA', '', '', 'Z4', 7, 8, '', 'intermediaire_avance', 'Travail à l''allure de course cible, pilier classique de préparation 10K', 'Construit', 44, 23),
  ('RUN-10K-02', 'run', 'run', 'Allure 10K', 'Fractionné long 10K', 'Développer l''allure 10K avec moins de fatigue', '3-4 x 2000m à allure 10K, r=2 min trot', '35-40 min total', 35, 40, 38, '92-97% VMA', '', '', 'Z4', 7, 8, '2 min trot', 'intermediaire_avance', 'idem 10K-01', 'Construit', 60, 24),
  ('RUN-10K-03', 'run', 'run', 'Allure 10K', 'Progressif vers 10K', 'Gestion d''allure en fin de course 10K', '6km EF puis 3km à allure 10K en finish', '35-40 min total', 35, 40, 38, '70-97% VMA', '', '', 'Z4', 5, 8, '', 'avance', 'Simule l''accélération finale d''une course de 10K', 'Construit', 60, 25),
  ('RUN-SEM-01', 'run', 'run', 'Allure Semi', 'Continu semi', 'Calibrer l''allure semi-marathon', '20-30 min continus à allure semi', '35-45 min total', 35, 45, 40, '92-96% VMA', '', '', 'Z4', 7, 7, '', 'intermediaire_avance', 'Séance de référence en préparation semi', 'Construit', 63, 26),
  ('RUN-SEM-02', 'run', 'run', 'Allure Semi', 'Fractionné semi', 'Développer l''allure semi avec moins de fatigue', '3 x 15 min à allure semi, r=3 min trot', '55-60 min total', 55, 60, 58, '92-96% VMA', '', '', 'Z4', 7, 7, '3 min trot', 'intermediaire_avance', 'idem SEM-01', 'Construit', 91, 27),
  ('RUN-SEM-03', 'run', 'run', 'Allure Semi', 'Progressif long + semi', 'Simuler la fin de course semi sur jambes fatiguées', '12km EF + 6km à allure semi en finish', '60-65 min total', 60, 65, 63, '70-96% VMA', '', '', 'Z4', 5, 7, '', 'avance', 'Approche la fatigue de fin de semi-marathon', 'Construit', 99, 28),
  ('RUN-SEM-04', 'run', 'run', 'Allure Semi', 'Sortie longue + blocs semi', 'Développer résistance et allure spécifique en une séance', '16-18km avec 2x3km à allure semi (r=1km EF)', '90-100 min', 90, 100, 95, '70-96% VMA', '', '', 'Z4', 5, 7, '1km EF', 'avance', 'Combine volume et spécificité, cohérent avec le rôle documenté de la sortie longue', 'Doherty & Keogh 2019', 149, 29),
  ('RUN-MAR-01', 'run', 'run', 'Allure Marathon', 'Bloc continu court', 'Calibrer l''allure marathon', '8-10 km continus à allure marathon', '45-55 min', 45, 55, 50, '78-84% VMA', '', '', 'Z3', 6, 6, '', 'intermediaire_avance', 'Travail direct à l''allure de course cible', 'Construit', 60, 30),
  ('RUN-MAR-02', 'run', 'run', 'Allure Marathon', 'Bloc continu long', 'Développer l''allure marathon, dose plus importante', '14-18 km continus à allure marathon', '65-85 min', 65, 85, 75, '78-84% VMA', '', '', 'Z3', 6, 7, '', 'avance', 'idem MAR-01', 'Construit', 90, 31),
  ('RUN-MAR-03', 'run', 'run', 'Allure Marathon', 'Sortie longue + bloc AM (séance-clé)', 'Développer volume + spécificité en une séance', '8-10km EF + 12-18km AM + 2-4km EF retour', '100-140 min', 100, 140, 120, '70-84% VMA', '', '', 'Z3', 5, 7, '', 'avance', 'Combine la variable ''sortie ≥32km'' et la spécificité d''allure marathon', 'Doherty & Keogh 2019 ; Fokkema 2020', 144, 32),
  ('RUN-MAR-04', 'run', 'run', 'Allure Marathon', 'AM fractionné', 'Développer l''allure marathon avec moins de fatigue cumulée', '3-4 x 4km à allure marathon, r=1km EF', '70-80 min', 70, 80, 75, '78-84% VMA', '', '', 'Z3', 6, 6, '1km EF', 'intermediaire_avance', 'Alternative au bloc continu pour les semaines de charge élevée', 'Construit', 90, 33),
  ('RUN-MAR-05', 'run', 'run', 'Allure Marathon', 'AM sur jambes fatiguées (bi-quotidien)', 'Simuler la gestion de l''allure cible en fin de course sur fatigue accumulée', 'Footing EF facile le matin (8-12km) puis bloc AM l''après-midi/soir (10-16km)', '2 sessions, 90-120 min cumulé', 90, 120, 105, '70-84% VMA', '', '', 'Z3', 6, 8, 'Plusieurs heures entre les 2 sessions, ravitaillement glucidique', 'avance', 'Technique de pré-fatigue utilisée par certains coachs ; non testée isolément dans la littérature citée, à utiliser avec prudence (risque mécanique)', 'Construit (extrapolation raisonnée)', 126, 34),
  ('RUN-LSD-01', 'run', 'run', 'Sortie longue', 'Longue EF pure', 'Développer le volume et l''endurance de base', 'Course continue à allure EF stable', '90-120 min', 90, 120, 105, '70-76% VMA', '', '', 'Z2', 4, 5, '', 'tous', 'Le kilométrage et la distance de la sortie la plus longue sont deux des variables les plus documentées de la performance marathon', 'Doherty & Keogh 2019 ; Fokkema 2020', 86, 35),
  ('RUN-LSD-02', 'run', 'run', 'Sortie longue', 'Longue progressive', 'Endurance + transition vers le seuil en fin de sortie', 'EF puis progressif jusqu''à allure semi sur les 20-30 derniers %', '100-130 min', 100, 130, 115, '70-90% VMA', '', '', 'Z3', 4, 7, '', 'intermediaire_avance', 'idem LSD-01 + travail de gestion d''allure', 'Construit', 138, 36),
  ('RUN-LSD-03', 'run', 'run', 'Sortie longue', 'Longue + fartlek libre', 'Variété + stimulus qualité sans séance dédiée', 'EF + 8-10 accélérations libres de 1-3 min pendant la sortie', '100-120 min', 100, 120, 110, '70-95% VMA', '', '', 'Z4', 4, 7, 'Retour EF entre chaque', 'intermediaire_avance', 'Approche documentée dans les plans sub-élites analysés', 'Analyse 92 plans marathon 2024', 172, 37),
  ('RUN-LSD-04', 'run', 'run', 'Sortie longue', 'Longue vallonnée/côtes', 'Renforcement fonctionnel via le dénivelé', 'EF sur parcours vallonné', '90-120 min', 90, 120, 105, '70-82% VMA', '', '', 'Z2', 5, 7, '', 'intermediaire_avance', 'Stimulus de force additionnel sans séance de muscu', 'Construit', 86, 38),
  ('RUN-LSD-05', 'run', 'run', 'Sortie longue', 'Longue + blocs seuil', 'Développer seuil et volume en une séance', 'EF + 2-3 x 10 min au seuil intégrés dans la sortie', '100-120 min', 100, 120, 110, '70-90% VMA', '', '', 'Z3', 5, 7, '3 min trot entre blocs', 'avance', 'Optimise le temps d''entraînement en combinant deux stimulus', 'Construit', 132, 39),
  ('RUN-LSD-06', 'run', 'run', 'Sortie longue', 'Longue nature/trail', 'Renforcement proprioceptif + endurance', 'EF sur sentier, terrain varié', '90-150 min', 90, 150, 120, '70-82% VMA', '', '', 'Z2', 5, 7, '', 'intermediaire_avance', 'Le terrain irrégulier ajoute un travail stabilisateur/proprioceptif', 'Construit', 98, 40),
  ('RUN-FAR-01', 'run', 'run', 'Fartlek', 'Fartlek suédois libre', 'Variété d''allures sans structure rigide', 'Alternance libre d''allures rapides (1-5 min) et récup (1-3 min) au ressenti', '40-50 min', 40, 50, 45, '78-105% VMA', '', '', 'Z5', 5, 8, 'Variable, au ressenti', 'tous', 'Format historique scandinave, bonne tolérance psychologique, entretient plusieurs filières', 'Construit', 84, 41),
  ('RUN-FAR-02', 'run', 'run', 'Fartlek', 'Fartlek pyramidal', 'Structurer la variété tout en gardant un aspect ludique', '1-2-3-4-3-2-1 min à allure rapide, récup égale au temps d''effort', '45-55 min', 45, 55, 50, '85-100% VMA', '', '', 'Z4', 6, 8, 'Égale au temps d''effort', 'intermediaire_avance', 'Structure la progression de la charge dans la séance', 'Construit', 78, 42),
  ('RUN-FAR-03', 'run', 'run', 'Fartlek', 'Fartlek nature', 'Variété + terrain naturel', 'Fartlek libre sur parcours vallonné/sentier', '40-60 min', 40, 60, 50, '78-105% VMA', '', '', 'Z5', 5, 8, 'Variable', 'intermediaire_avance', 'Combine les bénéfices du fartlek et du terrain naturel', 'Construit', 94, 43),
  ('RUN-COT-01', 'run', 'run', 'Côtes', 'Côtes courtes puissance', 'Puissance et recrutement musculaire', '8-10 x 15-20s en côte raide, effort maximal, retour marche', '25-30 min', 25, 30, 28, '—', '', '', 'Z5', 8, 9, 'Retour marche complet', 'avance', 'Stimulus proche de la pliométrie, similaire au format des ECR sur l''économie de course', 'RCT économie de course 2025', 52, 44),
  ('RUN-COT-02', 'run', 'run', 'Côtes', 'Côtes moyennes VO2max', 'Développer VO2max avec moins d''impact que sur plat', '8-10 x 60-90s en côte modérée à effort proche VO2max, retour trot', '40-45 min', 40, 45, 43, '100-108% VMA', '', '', 'Z5', 8, 8, 'Retour trot', 'avance', 'La pente réduit la vitesse absolue et donc l''impact au sol pour un stimulus cardio équivalent', 'Construit', 81, 45),
  ('RUN-COT-03', 'run', 'run', 'Côtes', 'Côtes longues seuil', 'Développer le seuil + force spécifique', '5-6 x 3-4 min en côte modérée à allure seuil, retour trot en descente', '45-50 min', 45, 50, 48, '85-92% VMA', '', '', 'Z4', 6, 7, 'Retour trot descente', 'avance', 'idem SEU-06', 'Construit', 75, 46),
  ('RUN-COT-04', 'run', 'run', 'Côtes', 'Descente technique', 'Travailler l''excentrique et la technique de descente', '6-8 descentes modérées à allure contrôlée, remontée en marche/trot', '30-40 min', 30, 40, 35, '70-85% VMA', '', '', 'Z3', 5, 6, 'Remontée marche', 'avance', 'Le travail excentrique en descente prépare les tissus (quadriceps) à l''impact répété', 'Construit', 42, 47),
  ('RUN-REC-01', 'run', 'run', 'Récupération', 'Footing très facile', 'Récupération active, favorise le flux sanguin sans stress supplémentaire', 'Course très lente, aucune contrainte d''allure', '20-40 min', 20, 40, 30, '60-70% VMA', '', '', 'Z2', 2, 3, '', 'tous', 'La récupération active accélère la clairance du lactate par rapport au repos complet', 'Construit (consensus large)', 24, 48),
  ('RUN-REC-02', 'run', 'run', 'Récupération', 'Footing + mobilité', 'Récupération + entretien de l''amplitude articulaire', '20-30 min très facile + 10 min mobilité hanches/chevilles', '30-40 min', 30, 40, 35, '60-70% VMA', '', '', 'Z2', 2, 3, '', 'tous', 'Complète la récupération active par un travail de mobilité', 'Construit', 29, 49),
  ('RUN-REC-03', 'run', 'run', 'Récupération', 'Marche/course alternée', 'Récupération active pour les jours de grande fatigue', 'Alternance 3 min course très facile / 2 min marche, 20-30 min', '20-30 min', 20, 30, 25, '55-65% VMA', '', '', 'Z1', 2, 2, '', 'tous', 'Réduit encore la contrainte mécanique tout en gardant une activité active', 'Construit', 13, 50),
  ('BIKE-END-01', 'bike', 'bike', 'Endurance', 'Sortie Z2 courte', 'Développer la base aérobie, densité mitochondriale', 'Roulage continu en Z2', '60-90 min', 60, 90, 75, '56-75% FTP', '69-83% FCmax', '85-95', 'Z2', null, null, 'Aucune', 'tous', 'La base aérobie en Z2 est le socle du volume d''entraînement, cohérent avec la distribution pyramidale/polarisée documentée', 'Seiler 2010', 61, 51),
  ('BIKE-END-02', 'bike', 'bike', 'Endurance', 'Sortie Z2 longue', 'Développement du volume aérobie', 'Roulage continu en Z2', '2h-4h', 120, 120, 120, '56-72% FTP', '69-80% FCmax', '85-95', 'Z2', null, null, 'Aucune', 'intermediaire_avance', 'idem END-01', 'Seiler 2010', 98, 52),
  ('BIKE-END-03', 'bike', 'bike', 'Endurance', 'Endurance progressive', 'Base aérobie + transition douce vers le tempo', 'Z2 avec 20 dernières minutes en Z3', '90-120 min', 90, 120, 105, '56-90% FTP', '69-94% FCmax', '85-95', 'Z3', null, null, 'Aucune', 'intermediaire_avance', 'Progression d''intensité en fin de sortie', 'Construit', 126, 53),
  ('BIKE-END-04', 'bike', 'bike', 'Endurance', 'Endurance + cadence variée', 'Base aérobie + coordination neuromusculaire', 'Z2 avec blocs de 5 min à cadence haute (100-110) et basse (60-70) en alternance', '90-120 min', 90, 120, 105, '56-75% FTP', '69-83% FCmax', '60-110 (variable)', 'Z2', null, null, 'Aucune', 'intermediaire_avance', 'La variation de cadence entretient le recrutement moteur sans charge métabolique supplémentaire', 'Construit', 86, 54),
  ('BIKE-END-05', 'bike', 'bike', 'Endurance', 'Endurance + micro-côtes', 'Base aérobie + force fonctionnelle', 'Z2 sur parcours vallonné, cadence naturelle en côte', '90-150 min', 90, 150, 120, '56-82% FTP', '69-88% FCmax', '70-90', 'Z2', null, null, 'Aucune', 'intermediaire_avance', 'Construit', 'Construit', 98, 55),
  ('BIKE-END-06', 'bike', 'bike', 'Endurance', 'Sortie longue nature/gravel', 'Base aérobie + engagement musculaire varié', 'Z2 continu sur terrain varié', '2h-4h', 120, 120, 120, '56-72% FTP', '69-80% FCmax', 'Variable', 'Z2', null, null, 'Aucune', 'avance', 'Construit', 'Construit', 98, 56),
  ('BIKE-END-07', 'bike', 'bike', 'Endurance', 'Récupération active Z1', 'Récupération, favorise le flux sanguin', 'Roulage très facile en Z1', '30-60 min', 30, 60, 45, 'jusqu''à 55% FTP', 'jusqu''à 68% FCmax', '85-95', 'Z1', null, null, '', 'tous', 'Consensus large sur la récupération active', 'Construit', 23, 57),
  ('BIKE-SS-01', 'bike', 'bike', 'Sweet Spot', '2x20min SS', 'Développer le seuil avec une fatigue moindre qu''au FTP pur', '2 x 20 min à 88-94% FTP, r=5 min Z1', '60-70 min', 60, 70, 65, '88-94% FTP', '84-94% FCmax', '85-95', 'Z3', null, null, '5 min Z1', 'intermediaire_avance', 'Le sweet spot maximise le rapport stimulus/fatigue pour développer le seuil sur des blocs courts', 'Rønnestad & Hansen', 78, 58),
  ('BIKE-SS-02', 'bike', 'bike', 'Sweet Spot', '3x15min SS', 'idem, format plus fractionné', '3 x 15 min à 88-94% FTP, r=5 min Z1', '65-75 min', 65, 75, 70, '88-94% FTP', '84-94% FCmax', '85-95', 'Z3', null, null, '5 min Z1', 'intermediaire_avance', 'idem SS-01', 'Rønnestad & Hansen', 84, 59),
  ('BIKE-SS-03', 'bike', 'bike', 'Sweet Spot', 'SS progressif', 'Développer le seuil avec intensité croissante', '3 blocs de 12 min, chacun 2-3% FTP plus haut (85%->94%)', '55-65 min', 55, 65, 60, '85-94% FTP', '82-94% FCmax', '85-95', 'Z3', null, null, '3 min Z1', 'avance', 'Construit', 'Construit', 72, 60),
  ('BIKE-SS-04', 'bike', 'bike', 'Sweet Spot', 'SS + surges', 'Seuil + capacité à absorber des à-coups (peloton)', '20 min SS avec surges de 15s à 120% FTP toutes les 3 min', '30-35 min', 30, 35, 33, '88-94% FTP', '84-94% FCmax', '90-100', 'Z3', null, null, '', 'avance', 'Simule les variations d''intensité en course/peloton', 'Construit', 40, 61),
  ('BIKE-SS-05', 'bike', 'bike', 'Sweet Spot', 'SS longue continue', 'Développer le seuil sur durée prolongée', '45-60 min continus à 88-92% FTP', '55-70 min', 55, 70, 63, '88-92% FTP', '84-92% FCmax', '85-95', 'Z3', null, null, '', 'avance', 'Format exigeant, réservé aux cyclistes expérimentés', 'Rønnestad & Hansen', 76, 62),
  ('BIKE-SS-06', 'bike', 'bike', 'Sweet Spot', 'SS pyramide', 'Varier la structure pour la motivation', '10-15-20-15-10 min à 88-92% FTP, r=3-5 min', '90-100 min', 90, 100, 95, '88-92% FTP', '84-92% FCmax', '85-95', 'Z3', null, null, '3-5 min Z1', 'avance', 'Construit', 'Construit', 114, 63),
  ('BIKE-FTP-01', 'bike', 'bike', 'Seuil', '2x20min seuil', 'Développer la puissance au seuil fonctionnel (FTP)', '2 x 20 min à 95-100% FTP, r=8-10 min Z1', '60-70 min', 60, 70, 65, '95-100% FTP', '95-100% FCmax', '85-95', 'Z4', null, null, '8-10 min Z1', 'avance', 'Format de référence pour développer le FTP', 'Coggan & Allen', 102, 64),
  ('BIKE-FTP-02', 'bike', 'bike', 'Seuil', '3x12min seuil', 'idem, plus fractionné', '3 x 12 min à 95-102% FTP, r=5 min Z1', '55-65 min', 55, 65, 60, '95-102% FTP', '95-102% FCmax', '85-95', 'Z4', null, null, '5 min Z1', 'intermediaire_avance', 'Coggan & Allen', 'Coggan & Allen', 94, 65),
  ('BIKE-FTP-03', 'bike', 'bike', 'Seuil', '4x8min seuil', 'idem, plus accessible', '4 x 8 min à 95-105% FTP, r=4 min Z1', '55-60 min', 55, 60, 58, '95-105% FTP', '95-105% FCmax', '85-95', 'Z4', null, null, '4 min Z1', 'intermediaire', 'Coggan & Allen', 'Coggan & Allen', 91, 66),
  ('BIKE-FTP-04', 'bike', 'bike', 'Seuil', 'Seuil continu', 'Développer la résistance au seuil en continu', '30-40 min continus à 91-98% FTP', '45-55 min', 45, 55, 50, '91-98% FTP', '95-100% FCmax', '85-90', 'Z4', null, null, '', 'avance', 'Coggan & Allen', 'Coggan & Allen', 78, 67),
  ('BIKE-FTP-05', 'bike', 'bike', 'Seuil', 'Over-under', 'Développer la capacité à tamponner le lactate au-dessus du seuil', '6 x (3 min à 100% FTP + 2 min à 105-110% FTP), r=5 min', '55-65 min', 55, 65, 60, '100-110% FTP', '95-106% FCmax', '85-95', 'Z4', null, null, '5 min Z1', 'avance', 'Format documenté pour améliorer la clairance du lactate', 'Coggan & Allen', 94, 68),
  ('BIKE-FTP-06', 'bike', 'bike', 'Seuil', 'Seuil en côte', 'Développer le seuil + force spécifique', '3-4 x 10 min en côte modérée à 95-100% FTP, cadence 70-80', '50-60 min', 50, 60, 55, '95-100% FTP', '95-100% FCmax', '70-80', 'Z4', null, null, 'Retour descente', 'avance', 'Construit', 'Construit', 86, 69),
  ('BIKE-VO2B-01', 'bike', 'bike', 'VO2max', '5x4min', 'Développer VO2max et la puissance aérobie maximale', '5 x 4 min à 106-120% FTP, r=4 min Z1', '55-65 min', 55, 65, 60, '106-120% FTP', '>106% FCmax', '90-100', 'Z5', null, null, '4 min Z1', 'avance', 'Format de référence pour développer VO2max à vélo', 'Laursen & Jenkins 2002', 112, 70),
  ('BIKE-VO2B-02', 'bike', 'bike', 'VO2max', '6x3min', 'Stimulus VO2max plus court', '6 x 3 min à 110-125% FTP, r=3 min Z1', '45-55 min', 45, 55, 50, '110-125% FTP', '>106% FCmax', '90-100', 'Z5', null, null, '3 min Z1', 'avance', 'Laursen & Jenkins 2002', 'Laursen & Jenkins 2002', 94, 71),
  ('BIKE-VO2B-03', 'bike', 'bike', 'VO2max', '8x2min', 'Stimulus encore plus court et intense', '8 x 2 min à 115-130% FTP, r=2 min Z1', '40-45 min', 40, 45, 43, '115-130% FTP', '>106% FCmax', '90-100', 'Z5', null, null, '2 min Z1', 'avance', 'Laursen & Jenkins 2002', 'Laursen & Jenkins 2002', 81, 72),
  ('BIKE-VO2B-04', 'bike', 'bike', 'VO2max', '30/30', 'Maximiser le temps passé à VO2max', '12-15 x 30s à 120% FTP / 30s à 50% FTP', '25-30 min', 25, 30, 28, '120-120% FTP', '>106% FCmax', '95-105', 'Z5', null, null, '30s', 'avance', 'Format classique pour maximiser le temps à VO2max malgré la récupération incomplète', 'Laursen & Jenkins 2002', 52, 73),
  ('BIKE-VO2B-05', 'bike', 'bike', 'VO2max', '40/20', 'Variante du 30/30', '10-12 x 40s à 115-125% FTP / 20s à 50% FTP', '20-25 min', 20, 25, 23, '115-125% FTP', '>106% FCmax', '95-105', 'Z5', null, null, '20s', 'avance', 'Construit', 'Construit', 43, 74),
  ('BIKE-VO2B-06', 'bike', 'bike', 'VO2max', 'Pyramide VO2max', 'Varier la durée pour la motivation', '1-2-3-4-3-2-1 min à 108-120% FTP, r=égale au temps d''effort', '45-50 min', 45, 50, 48, '108-120% FTP', '>106% FCmax', '90-100', 'Z5', null, null, 'Égale au temps d''effort', 'avance', 'Construit', 'Construit', 90, 75),
  ('BIKE-VO2B-07', 'bike', 'bike', 'VO2max', 'VO2max en côte', 'Développer VO2max avec un recrutement musculaire différent', '5-6 x 4 min en côte à 105-115% FTP, cadence 70-80, retour descente', '50-60 min', 50, 60, 55, '105-115% FTP', '>100% FCmax', '70-80', 'Z5', null, null, 'Retour descente', 'avance', 'Construit', 'Construit', 103, 76),
  ('BIKE-ANA-01', 'bike', 'bike', 'Anaérobie', '6x1min', 'Développer la capacité anaérobie et la tolérance au lactate', '6 x 1 min à 130-150% FTP, r=4 min Z1', '35-40 min', 35, 40, 38, '130-150% FTP', 'peu pertinent à cette intensité', '95-110', 'Z5', null, null, '4 min Z1', 'avance', 'Format de référence pour développer la puissance anaérobie', 'Laursen & Jenkins 2002', 71, 77),
  ('BIKE-ANA-02', 'bike', 'bike', 'Anaérobie', '10x30s', 'Stimulus plus court et intense', '10 x 30s à 150-170% FTP, r=4min30 Z1', '45-50 min', 45, 50, 48, '150-170% FTP', 'peu pertinent à cette intensité', '100-110', 'Z5', null, null, '4-5 min Z1', 'avance', 'Construit', 'Construit', 90, 78),
  ('BIKE-ANA-03', 'bike', 'bike', 'Anaérobie', '45/45', 'Développer la capacité à répéter des efforts intenses', '8-10 x 45s à 130-145% FTP / 45s Z1', '25-30 min', 25, 30, 28, '130-145% FTP', 'peu pertinent à cette intensité', '95-105', 'Z5', null, null, '45s', 'avance', 'Construit', 'Construit', 52, 79),
  ('BIKE-ANA-04', 'bike', 'bike', 'Anaérobie', 'Attaque simulée', 'Reproduire les efforts explosifs répétés d''une course', '5-6 x (15s sprint départ arrêté + 45s à 110% FTP), r=5 min', '40-45 min', 40, 45, 43, '110-200% FTP', 'peu pertinent à cette intensité', 'Variable', 'Z5', null, null, '5 min Z1', 'avance', 'Simule la dynamique d''une attaque en course', 'Construit', 81, 80),
  ('BIKE-ANA-05', 'bike', 'bike', 'Anaérobie', 'Série courte répétée', 'Développer la résistance à la répétition d''efforts', '3 séries de 4x1min à 140% FTP (r=1min), r=8min entre séries', '45-55 min', 45, 55, 50, '140-140% FTP', 'peu pertinent à cette intensité', '100-110', 'Z5', null, null, '1 min puis 8 min', 'avance', 'Construit', 'Construit', 94, 81),
  ('BIKE-SPR-01', 'bike', 'bike', 'Sprint/Neuromusculaire', 'Sprints répétés 10-15s', 'Puissance maximale et recrutement neuromusculaire', '6-10 x 10-15s sprint maximal, r=3-5 min complète', '30-40 min', 30, 40, 35, '>150% FTP', 'peu pertinent à cette intensité', 'Max', 'Z5', null, null, '3-5 min complète', 'avance', 'Pilier classique de l''entraînement cycliste de puissance, peu documenté dans les études marathon citées', 'Construit', 66, 82),
  ('BIKE-SPR-02', 'bike', 'bike', 'Sprint/Neuromusculaire', 'Sprints en côte', 'idem + composante force', '5-8 x 10s sprint en côte, retour roulage descente', '30-35 min', 30, 35, 33, '>150% FTP', 'peu pertinent à cette intensité', '60-80 (bas)', 'Z5', null, null, 'Retour descente', 'avance', 'Construit', 'Construit', 62, 83),
  ('BIKE-SPR-03', 'bike', 'bike', 'Sprint/Neuromusculaire', 'Sprints groupés (leadout)', 'Simuler un effort de sprint final de course', '3 séries de 3 sprints de 8-10s rapprochés (r=1min), r=6min entre séries', '30-35 min', 30, 35, 33, '>150% FTP', 'peu pertinent à cette intensité', 'Max', 'Z5', null, null, '1 min puis 6 min', 'avance', 'Construit', 'Construit', 62, 84),
  ('BIKE-SPR-04', 'bike', 'bike', 'Sprint/Neuromusculaire', 'Force-vitesse départs arrêtés', 'Développer l''accélération pure', '6-8 sprints départ arrêté 6-8s, récup complète 3 min', '25-30 min', 25, 30, 28, '>150% FTP', 'peu pertinent à cette intensité', 'Progressive', 'Z5', null, null, '3 min complète', 'avance', 'Construit', 'Construit', 52, 85),
  ('BIKE-SPR-05', 'bike', 'bike', 'Sprint/Neuromusculaire', 'Cadence explosive', 'Développer la vitesse de pédalage maximale', '8-10 x 15s à cadence maximale (>130) sur braquet léger, récup 2-3min', '25-30 min', 25, 30, 28, 'jusqu''à 100% FTP', 'peu pertinent à cette intensité', '>130', 'Z4', null, null, '2-3 min', 'intermediaire_avance', 'Construit', 'Construit', 44, 86),
  ('BIKE-FOR-01', 'bike', 'bike', 'Force/Cadence basse', '4x8min basse cadence', 'Développer la force musculaire spécifique au pédalage', '4 x 8 min à 80-90% FTP, cadence 50-60, r=4 min', '55-65 min', 55, 65, 60, '80-90% FTP', '84-90% FCmax', '50-60', 'Z3', null, null, '4 min', 'avance', 'Le travail à basse cadence sollicite davantage la force musculaire que le système cardiovasculaire', 'Construit', 72, 87),
  ('BIKE-FOR-02', 'bike', 'bike', 'Force/Cadence basse', 'Montée assise force', 'Développer la force en position assise', '5-6 x 5 min en côte assis, cadence 55-65, 85-95% FTP', '50-60 min', 50, 60, 55, '85-95% FTP', '88-95% FCmax', '55-65', 'Z3', null, null, 'Retour descente', 'avance', 'Construit', 'Construit', 66, 88),
  ('BIKE-FOR-03', 'bike', 'bike', 'Force/Cadence basse', 'Sur-braquet répétitions', 'Développer la force sur plat', '6 x 5 min sur braquet lourd, cadence 50-55, 80-88% FTP', '55-65 min', 55, 65, 60, '80-88% FTP', '84-90% FCmax', '50-55', 'Z3', null, null, '3-4 min', 'avance', 'Construit', 'Construit', 72, 89),
  ('BIKE-FOR-04', 'bike', 'bike', 'Force/Cadence basse', 'Cadence sous-maximale prolongée', 'Développer l''endurance de force', '2 x 15 min à 75-85% FTP, cadence 55-65', '45-50 min', 45, 50, 48, '75-85% FTP', '80-88% FCmax', '55-65', 'Z3', null, null, '5 min', 'intermediaire_avance', 'Construit', 'Construit', 58, 90),
  ('BIKE-FOR-05', 'bike', 'bike', 'Force/Cadence basse', 'Force + finish sprint', 'Combiner force et explosivité', '4 x 6 min basse cadence (80-88% FTP, 55rpm) terminés par 15s sprint', '45-50 min', 45, 50, 48, '80-88% FTP', '84-90% FCmax', '55 puis max', 'Z3', null, null, '4 min', 'avance', 'Construit', 'Construit', 58, 91),
  ('BIKE-RECV-01', 'bike', 'bike', 'Récupération', 'Récupération très légère', 'Récupération active', 'Roulage Z1 strict, cadence libre', '30-45 min', 30, 45, 38, 'jusqu''à 55% FTP', 'jusqu''à 68% FCmax', '80-90', 'Z1', null, null, '', 'tous', 'Consensus large sur la récupération active', 'Construit', 19, 92),
  ('BIKE-RECV-02', 'bike', 'bike', 'Récupération', 'Récup + cadence haute légère', 'Récupération + entretien de la fluidité de pédalage', 'Z1 avec cadence 95-100 sans charge', '30-45 min', 30, 45, 38, 'jusqu''à 55% FTP', 'jusqu''à 68% FCmax', '95-100', 'Z1', null, null, '', 'tous', 'Construit', 'Construit', 19, 93),
  ('BIKE-RECV-03', 'bike', 'bike', 'Récupération', 'Récup fractionnée courte', 'Récupération active pour jours de grande fatigue', '20-30 min Z1 avec 3-4 accélérations très brèves (10s) sans forcer', '25-30 min', 25, 30, 28, 'jusqu''à 55% FTP', 'jusqu''à 68% FCmax', '85-90', 'Z1', null, null, '', 'tous', 'Construit', 'Construit', 14, 94),
  ('BIKE-SPE-01', 'bike', 'bike', 'Spécifique', 'Simulation contre-la-montre', 'Développer la gestion d''un effort maximal soutenu', '20-40 min à effort maximal soutenable (95-100% FTP), pacing constant', '40-60 min', 40, 60, 50, '95-100% FTP', '95-102% FCmax', '90-100', 'Z4', null, null, '', 'avance', 'Simule un contre-la-montre réel', 'Coggan & Allen', 78, 95),
  ('BIKE-SPE-02', 'bike', 'bike', 'Spécifique', 'Brick vélo-course à pied', 'Préparer la transition musculaire vélo -> course (triathlon)', '45-60 min vélo Z2-Z3 puis transition rapide et 15-20 min course à pied à allure EF/seuil', '70-90 min', 70, 90, 80, '70-90% FTP', '80-95% FCmax', '85-95', 'Z3', null, null, 'Transition <5 min', 'avance', 'Réplique le stress spécifique de la transition en triathlon', 'Construit', 96, 96),
  ('BIKE-SPE-03', 'bike', 'bike', 'Spécifique', 'Longue avec blocs allure cible', 'Développer la spécificité course sur un objectif vélo (cyclosportive/CLM)', 'Sortie longue Z2 avec 3-4 blocs de 10-15 min à l''allure cible de l''objectif', '2h-3h', 120, 120, 120, '56-100% FTP', '69-100% FCmax', '85-95', 'Z4', null, null, '5 min entre blocs', 'avance', 'Combine volume et spécificité, analogue à la sortie longue + allure cible en course à pied', 'Construit (par analogie à Doherty & Keogh 2019)', 188, 97),
  ('BIKE-MIX-01', 'bike', 'bike', 'Polarisé/Mixte', 'Endurance + finish VO2max', 'Terminer une sortie facile par un stimulus de qualité', '60-90 min Z2 puis 4-5 x 3 min à 110% FTP en fin de sortie', '75-105 min', 75, 105, 90, '56-110% FTP', '>69% FCmax', '85-95 puis 95-100', 'Z4', null, null, '3 min entre répétitions', 'avance', 'Optimise le temps d''entraînement dans une distribution pyramidale/polarisée', 'Seiler 2010', 141, 98),
  ('BIKE-MIX-02', 'bike', 'bike', 'Polarisé/Mixte', 'Tempo + sprint finish', 'Développer le tempo puis la puissance neuromusculaire', '30 min à 80-88% FTP puis 5 x 15s sprint (r=2min)', '45-50 min', 45, 50, 48, '80-88% FTP', '84-90% FCmax', '85-95 puis max', 'Z3', null, null, '2 min entre sprints', 'avance', 'Construit', 'Construit', 58, 99),
  ('BIKE-MIX-03', 'bike', 'bike', 'Polarisé/Mixte', 'Journée polarisée (split AM/PM)', 'Cumuler un gros volume Z1/Z2 avec une touche de qualité, sans excès de fatigue', 'Matin : 60-90 min Z2 ; Soir : 20 min Z1 + 4x2min à 105% FTP', '2 sessions, 100-130 min cumulé', 100, 130, 115, '56-105% FTP', '>69% FCmax', '85-95', 'Z4', null, null, 'Plusieurs heures entre sessions', 'avance', 'Réplique la logique polarisée sur une journée à haut volume, analogue au principe du bi-quotidien en course à pied', 'Construit (par analogie)', 180, 100)
on conflict (code) do update set
  sport=excluded.sport, disc=excluded.disc, category=excluded.category, title=excluded.title,
  objective=excluded.objective, structure=excluded.structure, duration_label=excluded.duration_label,
  dur_min=excluded.dur_min, dur_max=excluded.dur_max, dur=excluded.dur,
  zone_label=excluded.zone_label, zone_hr=excluded.zone_hr, cadence=excluded.cadence, zone=excluded.zone,
  rpe_low=excluded.rpe_low, rpe_high=excluded.rpe_high, recovery=excluded.recovery, level=excluded.level,
  rationale=excluded.rationale, reference=excluded.reference, tss=excluded.tss, sort=excluded.sort;

