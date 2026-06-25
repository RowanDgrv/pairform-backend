# PairForm — Mise en ligne du back-end (runbook démo)

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
Dans `web/pairform-client.js` (et la copie dans `~/Downloads/files_extracted/`),
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
  → `charges_enabled=false`), PairForm encaisse ; la bascule vers le club est
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
  device-connect device-sync device-disconnect

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
  -F verify_token=pairform-strava
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

## Garmin / Coros (pour les rendez-vous d'homologation)
Les **flux complets sont codés** (`device-connect` + `_shared/coros.ts` /
`_shared/garmin.ts` + callbacks + webhooks). Il ne manque que les **clés
partenaire** (self-service impossible, contrairement à Strava) :
- **Garmin** : *Garmin Connect Developer Program* (Health/Activity API, **OAuth 1.0a**,
  signeur HMAC-SHA1 validé par test). Callback domain à régler = ton domaine
  functions. Webhook (push/ping) → `…/functions/v1/garmin-webhook`.
  `GARMIN_CONSUMER_KEY` / `GARMIN_CONSUMER_SECRET`.
- **Coros** : *COROS Open API* (**OAuth2**). Redirect URI =
  `…/functions/v1/coros-oauth-callback`. Data subscription → `…/coros-webhook`.
  `COROS_CLIENT_ID` / `COROS_CLIENT_SECRET`.

Tant que `GARMIN_*` / `COROS_*` sont vides, les boutons Garmin/Coros renvoient
« intégration en cours d'homologation » — sans casser la démo. Dès réception des
clés : renseigne-les et déploie ; il restera à **ajuster les noms de champs
d'activité** au format réel de chaque API (les normaliseurs sont défensifs et
conservent le payload brut dans `external_activities.raw`).

> Les endpoints exacts de liste d'activités Coros et le format des push
> Garmin/Coros peuvent varier selon la version d'API attribuée : à confirmer
> avec leur doc une fois l'accès obtenu (constantes isolées en haut des fichiers).

> Argumentaire homologation : montre la démo Strava live + ce dépôt
> (`device_connections`, normalisation `external_activities`, webhooks) comme
> preuve d'intégration prête côté plateforme.

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
| device-connect | ✅ | démarre l'OAuth (Strava/Coros/Garmin); renvoie l'URL |
| strava-oauth-callback | ❌ | retour OAuth Strava → stocke jetons + import |
| strava-webhook | ❌ | push d'activités Strava |
| coros-oauth-callback | ❌ | retour OAuth2 Coros → jetons + import |
| coros-webhook | ❌ | data subscription Coros |
| garmin-oauth-callback | ❌ | retour OAuth1.0a Garmin → jetons + import |
| garmin-webhook | ❌ | push/ping d'activités Garmin |
| device-sync | ✅ | import manuel (Strava/Coros/Garmin) |
| device-disconnect | ✅ | délie un compte + révoque le jeton |

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
