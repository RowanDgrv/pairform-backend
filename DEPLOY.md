# Sillance — Mise en ligne du back-end (runbook démo)

Objectif : un environnement réel pour (a) une démo investisseurs et (b) obtenir
les autorisations de synchronisation **Strava / Garmin / Coros**.

Tout le **code** est prêt. Restent les actions qui demandent **tes comptes et
tes clés** (je ne peux pas créer de projet Supabase / Stripe / Strava à ta place).
Suis les étapes dans l'ordre — compte ~45 min la première fois.

---

## 0. Installer les outils (machine actuelle : rien d'installé)
```bash
brew install supabase/tap/supabase     # CLI Supabase
brew install deno                      # runtime des edge functions (tests locaux)
# Stripe CLI (optionnel, pour tester les webhooks en local) :
brew install stripe/stripe-cli/stripe
```

## 1. Créer le projet Supabase
1. https://supabase.com → **New project** (région EU). Note le mot de passe DB.
2. Project Settings → API : récupère `Project URL`, clé `anon`, clé `service_role`.
3. Connecte la CLI :
   ```bash
   cd ~/pairform-backend
   supabase login
   supabase link --project-ref <REF_DU_PROJET>     # REF = sous-domaine de l'URL
   ```

## 2. Pousser le schéma (14 + tables device-sync)
```bash
supabase db push           # applique migrations/0001 … 0008
```
> Vérifie dans Supabase → Table Editor que `device_connections`,
> `external_activities`, `oauth_states` et la vue `my_devices` existent.

## 3. Renseigner le front
Dans `web/sillance-client.js` (et la copie dans `~/Downloads/files_extracted/`),
remplace en haut :
```js
const SUPABASE_URL = "https://VOTRE-PROJET.supabase.co";
const SUPABASE_ANON_KEY = "eyJ...anon...";
```

## 4. Stripe (3 abonnements SaaS + formules club)
1. https://dashboard.stripe.com (mode test) → **Produits** : crée 3 produits
   récurrents (Coach, Athlète, Club) → récupère les 3 `price_...`.
2. Webhook : Developers → Webhooks → endpoint
   `https://VOTRE-PROJET.supabase.co/functions/v1/stripe-webhook`
   events `checkout.session.completed`, `customer.subscription.*`,
   **`account.updated`** (statut Connect des clubs) → récupère le `whsec_...`.

### 4b. Formules CLUB (vendues par un club à ses adhérents) — Stripe Connect
- **Pas de Price ID à créer** : les tarifs des 3 formules (dropin 15€ one-shot,
  sub 59€/mois, coach 119€/mois) sont **édités par chaque club** et envoyés en
  `price_data` dynamique par `club-subscribe`.
- Active **Connect** : dashboard → Connect → active les comptes **Express**.
- Règle la commission plateforme via `PLATFORM_FEE_PERCENT` (0 par défaut) et
  `STRIPE_CONNECT_COUNTRY` (FR) dans `.env`.
- **Fallback démo** : tant qu'un club n'a pas fini son onboarding (`club-connect`
  → `charges_enabled=false`), Sillance encaisse ; la bascule vers le club est
  automatique une fois l'onboarding terminé (event `account.updated`).

## 5. Strava (synchro — inscription immédiate)
1. https://www.strava.com/settings/api → crée une application.
   - **Authorization Callback Domain** = `VOTRE-PROJET.supabase.co`
   - Récupère `Client ID` + `Client Secret`.
2. Renseigne `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_VERIFY_TOKEN`
   dans `.env`.

## 6. (Optionnel) Resend pour les emails d'invitation
https://resend.com → API key + domaine vérifié → `RESEND_API_KEY`, `RESEND_FROM`.
Sans clé : l'invitation fonctionne quand même (renvoie le lien à partager).

## 7. Pousser les secrets + déployer les functions
```bash
cp .env.example .env        # puis remplis TOUTES les valeurs
supabase secrets set --env-file ./.env

# Functions protégées par JWT (défaut) :
supabase functions deploy stripe-checkout stripe-portal creneau-checkout \
  club-subscribe club-connect coach-connect coach-subscribe \
  invite-athlete accept-invite video-url \
  device-connect device-sync device-disconnect strava-activity-streams

# Functions appelées par un tiers (pas de JWT : callbacks OAuth + webhooks) :
supabase functions deploy stripe-webhook         --no-verify-jwt
supabase functions deploy strava-oauth-callback  --no-verify-jwt
supabase functions deploy strava-webhook         --no-verify-jwt
supabase functions deploy coros-oauth-callback   --no-verify-jwt
supabase functions deploy coros-webhook          --no-verify-jwt
supabase functions deploy garmin-oauth-callback  --no-verify-jwt
supabase functions deploy garmin-webhook         --no-verify-jwt
```

## 8. Souscrire au webhook Strava (push automatique des activités)
```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=$STRAVA_CLIENT_ID \
  -F client_secret=$STRAVA_CLIENT_SECRET \
  -F callback_url=https://VOTRE-PROJET.supabase.co/functions/v1/strava-webhook \
  -F verify_token=sillance-strava
```
Strava appelle l'URL en GET pour valider (la function renvoie le `hub.challenge`),
puis pousse chaque nouvelle activité. Une seule souscription par application.

## 9. Lancer la démo
```bash
cd ~/Downloads/files_extracted && python3 -m http.server 5500
# http://localhost:5500/apex-tri-calendrier.html
```
Badge ☁︎ (haut-droite) → crée un compte → SQL Editor : `select seed_demo(auth.uid());`
pour des données. Dans l'espace athlète : **Se connecter avec Strava** → autorise →
retour appli → **Synchroniser** → tes vraies activités apparaissent.

---

## COROS — serveur MCP self-service (opérationnel, SANS homologation)

Depuis le 07/09/2026, COROS ne passe plus par le "COROS Open API" partenaire mais
par un **serveur MCP hébergé** (`https://mcpeu.coros.com/mcp`) avec **OAuth 2.1 +
PKCE + enregistrement dynamique de client** — aucun dossier, aucune clé à obtenir.

**Code** : `_shared/corosMcp.ts` (remplace `_shared/coros.ts`, obsolète) —
`device-connect` (URL d'autorisation), `coros-oauth-callback` (échange + import
initial), `coros-poll` (tirage programmé : le self-service n'a PAS de webhook),
`coros-webhook` désactivée (410).

**Ce qui remonte** (lecture) : activités (résumé + URL du `.FIT` original dans
`raw.fit_url`, quota 50 `.fit`/jour/compte), VFC sommeil, récupération, charge —
rangés dans `device_connections.meta.wellness` + `checkins.hrv` du jour.

**Écriture** (pousser une séance Sillance vers la montre) : `pushPlannedSession`
est **câblé mais inerte** — les tools `generateTrainingPlan`/`updateTrainingPlan`
sortent de bêta COROS **~mi-septembre 2026**. `corosWriteAvailable()` teste
`tools/list` et bascule automatiquement dès qu'ils apparaissent.

### Mise en route
1. **Migration** : `supabase db push` (applique `0043_coros_mcp.sql` :
   `device_connections.meta`, table `integration_oauth_clients`, vue `my_devices`).
2. **Secret** (si pas déjà là) : `OAUTH_TOKEN_ENC_KEY` + `CRON_SECRET`.
   Facultatif : `COROS_MCP_CLIENT_ID` (fige le client au lieu du DCR auto),
   `COROS_MCP_BASE` (défaut zone EU).
3. **Valider la mécanique MCP** (2 min, un login navigateur) :
   ```bash
   node test/coros-mcp-spike.mjs      # ouvre l'autorisation COROS, teste tout
   ```
   Vert → déploie. Rouge → l'erreur pointe l'ajustement à faire dans corosMcp.ts.
4. **Déployer** :
   ```bash
   supabase functions deploy device-connect device-sync
   supabase functions deploy coros-oauth-callback --no-verify-jwt
   supabase functions deploy coros-poll           --no-verify-jwt
   supabase functions deploy coros-webhook        --no-verify-jwt
   ```
5. **Planifier le tirage** (SQL Editor du dashboard, une fois — hors migration
   versionnée, comme morning-digest) :
   ```sql
   select cron.schedule(
     'coros-poll', '17 */2 * * *',           -- toutes les 2 h, minute 17
     $$ select net.http_post(
          url := 'https://onbsgohvqejccowfnrbs.supabase.co/functions/v1/coros-poll',
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'x-cron-secret', current_setting('app.settings.cron_secret', true)),
          body := '{}'::jsonb) $$);
   ```
   (`alter database postgres set app.settings.cron_secret = '<même valeur que CRON_SECRET>';`
   si pas déjà fait pour coach-alert-on-checkin.)
6. Athlète : **Connecter COROS** → login COROS → retour appli → activités +
   « état de forme » remontent. Bouton **Synchroniser** = `device-sync` (pull
   immédiat) ; sinon `coros-poll` s'en charge toutes les 2 h.

## Garmin (toujours en attente d'homologation)
Flux codé (`_shared/garmin.ts` + callbacks + `garmin-webhook`, **OAuth 1.0a**,
signeur HMAC-SHA1 validé). *Garmin Connect Developer Program* fermé aux nouveaux
entrants → veille passive. En attendant : import `.FIT` manuel + COROS.
`GARMIN_CONSUMER_KEY` / `GARMIN_CONSUMER_SECRET` vides = bouton « en cours
d'homologation », sans casser la démo.

> Argumentaire (si besoin) : démo Strava + COROS live + ce dépôt
> (`device_connections`, `external_activities`, `corosMcp.ts`) = preuve
> d'intégration prête côté plateforme.

## Aide-mémoire des Edge Functions
| Function | JWT | Rôle |
|---|---|---|
| stripe-checkout / stripe-portal | ✅ | abonnements |
| stripe-webhook | ❌ | source de vérité abonnements |
| creneau-checkout | ✅ | paiement créneau Hyrox (formule « À la séance ») |
| club-subscribe | ✅ | abonnement membre→formule club (sub/coach), Connect + fallback |
| club-connect | ✅ | onboarding Stripe Connect (compte Express) du club |
| coach-connect | ✅ | onboarding Stripe Connect (compte Express) du coach solo |
| coach-subscribe | ✅ | abonnement athlète→coach (suivi récurrent), Connect + fallback |
| invite-athlete / accept-invite | ✅ | invitations coach→athlète (+email Resend) |
| video-url | ✅ | URL signée vidéo premium |
| device-connect | ✅ | démarre l'OAuth (Strava / COROS MCP / Garmin); renvoie l'URL |
| strava-oauth-callback | ❌ | retour OAuth Strava → stocke jetons + import |
| strava-webhook | ❌ | push d'activités Strava |
| coros-oauth-callback | ❌ | retour OAuth 2.1 (PKCE) COROS MCP → jetons + import + wellness |
| coros-poll | ❌ | tirage programmé COROS (pas de webhook en self-service) ; `x-cron-secret` |
| coros-webhook | ❌ | **désactivée** (410) — le MCP self-service ne pousse pas |
| garmin-oauth-callback | ❌ | retour OAuth1.0a Garmin → jetons + import |
| garmin-webhook | ❌ | push/ping d'activités Garmin |
| device-sync | ✅ | import manuel (Strava/Coros/Garmin) |
| device-disconnect | ✅ | délie un compte + révoque le jeton |
| premium-subscribe | ✅ | checkout « Sillance Premium » coach (bibliothèque + IA) |
| club-premium-subscribe | ✅ | checkout « Sillance Premium Club » (propriétaire du club) |
| strava-activity-streams | ✅ | détail seconde-par-seconde (GPS/FC/allure/puissance) d'une activité Strava, à la demande + cache |

## TODO — facturation club (à durcir avant la prod)
À traiter avant d'ouvrir les paiements club à de vrais clubs (cf. `club-subscribe`) :

1. **Vérifier l'`apiVersion` Stripe pour les abonnements Connect.**
   `club-subscribe`/`club-connect` reprennent `apiVersion: "2024-06-20"` (cohérence
   avec les fonctions existantes). Au déploiement, confirmer que `transfer_data` +
   `application_fee_percent` posés sur `subscription_data` passent bien avec cette
   version ; sinon bumper l'API Stripe (et re-tester un abo `sub`/`coach` en mode test).

2. **Membre sans compte (`club_members.athlete_id` null).**
   Aujourd'hui, si le gérant abonne un membre sans compte, le payeur retombe sur le
   gérant (sa carte) — cf. `club-subscribe` l. ~74 (`payerId = member.athlete_id ?? user.id`).
   OK pour la démo ; en prod, exiger d'**inviter/connecter le membre d'abord**
   (lien d'invitation → compte → `athlete_id` rempli) avant de lancer un abonnement
   récurrent à son nom.

## Add-on « Assistant IA » coach (migration 0009)
Active le résumé + recommandations par séance (Claude). Voir `SILLANCE-AI-ADDON-PLAN.md`.

1. **Migration** : `supabase db push` (applique `0009_ai_addon.sql` → tables `ai_addons`,
   `session_summaries`, helper `has_ai_addon`).
2. **Secrets** : renseigner `ANTHROPIC_API_KEY` (+ éventuellement `ANTHROPIC_MODEL`,
   `AI_ADDON_PRICE_EUR`, `STRIPE_PRICE_AI`) puis `supabase secrets set --env-file .env`.
3. **Déployer les fonctions** (gate JWT, NE PAS mettre `--no-verify-jwt`) :
   `supabase functions deploy session-summary ai-addon-subscribe`
4. **Webhook** : aucune action — `stripe-webhook` route déjà `metadata.kind === "ai_addon"`
   vers `ai_addons` (déployer la nouvelle version du webhook).
5. **Vérif** : un coach sans add-on appelant `session-summary` reçoit `402 add_on_required` ;
   après checkout `ai-addon-subscribe` + webhook, `has_ai_addon` passe à true et l'analyse se génère.

> Coût maîtrisé : prompt caching des rubriques + cache `session_summaries` (1 appel API max/séance).

## Sillance Premium — bibliothèque de séances + Assistant IA (migration 0045)

Offre payante coach **et** club qui débloque : les **100 séances-types** course & vélo
(`library_sessions`, fiches prêtes avec objectif / structure / zone / justification /
référence) **+** l'Assistant IA (inclus, pas de double paiement avec l'add-on 0009).

**Entitlement** : `coach_premium` (abo coach, écrit par le webhook), `clubs.premium_until`
(un club paie → ses membres `role in (coach,admin)` + le propriétaire héritent),
`profiles.staff` (comptes Sillance, gratuit — **`rowandegraeve@gmail.com` posé staff
par la migration**). Portes : `has_premium()`, `has_library_access()`, RLS de
`library_sessions` = `my_library_access()`. `has_ai_addon()` renvoie vrai si Premium.

1. **Migration** : `supabase db push` (applique `0045_premium_library.sql` : tables +
   helpers + **seed des 100 fiches** + grant staff admin).
2. **Prix** (placeholders — à arrêter) : `PREMIUM_PRICE_EUR` (29), `PREMIUM_TRIAL_DAYS`
   (14), `CLUB_PREMIUM_PRICE_EUR` (79). Optionnel : `STRIPE_PRICE_PREMIUM` /
   `STRIPE_PRICE_CLUB_PREMIUM` (Price fixes). `supabase secrets set --env-file .env`.
3. **Déployer** (gate JWT) :
   `supabase functions deploy premium-subscribe club-premium-subscribe stripe-webhook`
4. **Webhook** : aucune config Stripe supplémentaire — `stripe-webhook` route déjà
   `kind in (coach_premium, club_premium)`. Redéployer la nouvelle version (étape 3).
5. **Vérif** : `rowandegraeve@gmail.com` lit `library_sessions` immédiatement (staff).
   Un coach lambda : 0 ligne tant qu'il n'a pas Premium ; après checkout
   `premium-subscribe` + webhook → `has_premium` = true, la bibliothèque et l'analyse IA
   s'ouvrent. Club : `club-premium-subscribe` (body `{club_id}`, réservé au propriétaire)
   → `clubs.premium_until` posé → les coachs du club héritent.

> Contenu : `content/library/library.json` (source parsée) + `parse.mjs`. Pour mettre à
> jour une fiche : éditer le docx, re-parser, régénérer le bloc `insert … on conflict`.
