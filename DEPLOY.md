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
supabase db push           # applique migrations/0001 … 0005
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

## 4. Stripe (3 abonnements)
1. https://dashboard.stripe.com (mode test) → **Produits** : crée 3 produits
   récurrents (Coach, Athlète, Club) → récupère les 3 `price_...`.
2. Webhook : Developers → Webhooks → endpoint
   `https://VOTRE-PROJET.supabase.co/functions/v1/stripe-webhook`
   events `checkout.session.completed`, `customer.subscription.*` →
   récupère le `whsec_...`.

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
  invite-athlete accept-invite video-url \
  device-connect device-sync device-disconnect

# Functions appelées par un tiers (pas de JWT) :
supabase functions deploy stripe-webhook        --no-verify-jwt
supabase functions deploy strava-oauth-callback --no-verify-jwt
supabase functions deploy strava-webhook        --no-verify-jwt
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
Le code est branché de façon générique (`device-connect` + `_shared/providers.ts`)
mais leurs APIs exigent une **validation partenaire** avant d'avoir des clés :
- **Garmin** : *Garmin Connect Developer Program* (Health/Activity API, OAuth1.0a).
- **Coros** : *COROS Open API* (OAuth2).

Tant que `GARMIN_*` / `COROS_*` sont vides, les boutons renvoient un message
« intégration en cours d'homologation » — sans casser la démo. Dès réception des
clés : renseigne-les, je finalise le mapping d'activités spécifique (1 fonction).

> Argumentaire homologation : montre la démo Strava live + ce dépôt
> (`device_connections`, normalisation `external_activities`, webhooks) comme
> preuve d'intégration prête côté plateforme.

## Aide-mémoire des Edge Functions
| Function | JWT | Rôle |
|---|---|---|
| stripe-checkout / stripe-portal | ✅ | abonnements |
| stripe-webhook | ❌ | source de vérité abonnements |
| creneau-checkout | ✅ | paiement créneau Hyrox |
| invite-athlete / accept-invite | ✅ | invitations coach→athlète (+email Resend) |
| video-url | ✅ | URL signée vidéo premium |
| device-connect | ✅ | démarre l'OAuth (Strava/…); renvoie l'URL |
| strava-oauth-callback | ❌ | retour OAuth Strava → stocke jetons + import |
| strava-webhook | ❌ | push d'activités Strava |
| device-sync | ✅ | import manuel des activités |
| device-disconnect | ✅ | délie un compte + révoque le jeton |
