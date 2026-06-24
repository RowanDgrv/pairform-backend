# PairForm — Back-end (Supabase + Stripe)

Back-end pour l'app de coaching triathlon/Hyrox. Couvre **les 3 rôles d'un coup** :
coach (phase 1), athlète B2C (phase 3) et club (phase 2). Conçu pour se brancher
sur les fichiers HTML existants sans les réécrire.

> v1 volontairement "ça marche", pas "parfait". On itère ensuite (RLS plus fine,
> invitations, paiement des créneaux à la carte, etc.).

## Ce qu'il y a dans la boîte

```
supabase/
  migrations/
    0001_init.sql                  → tout le schéma + RLS (3 rôles)
    0002_seed_videos.sql           → catalogue vidéo (brique B2C)
    0003_invites_payments_storage.sql → invitations, paiement créneaux, Storage, triggers
    0004_seed_demo.sql             → fonction seed_demo() pour données de test
  functions/
    stripe-checkout/       → lance un abonnement (plan coach/athlete/club)
    stripe-webhook/        → SOURCE DE VÉRITÉ : abos + paiements créneaux (Stripe → DB)
    stripe-portal/         → gérer/annuler son abo
    invite-athlete/        → coach invite un athlète par email (token)
    accept-invite/         → l'athlète accepte l'invitation → lien coach↔athlète
    creneau-checkout/      → paiement one-shot d'un créneau à la carte (Hyrox)
    video-url/             → URL signée d'une vidéo, gated par l'abonnement
    _shared/cors.ts
  config.toml
web/
  pairform-client.js       → pont navigateur : auth + données + Stripe + invites
.env.example               → secrets à renseigner
```

## Modèle de données (résumé)

| Table | Rôle | Vient de l'app |
|---|---|---|
| `profiles` | compte + rôle | mode coach/athlete/club |
| `athlete_profiles` | FTP/PMA/VMA/CSS/FC… | `ATHLETE_REF` |
| `coach_athlete` | la "paire" | lien coach↔athlète |
| `sessions` | bibliothèque de séances | builder `blocks` (JSON) |
| `scheduled_sessions` | séances planifiées | `planning[date]` |
| `records` | records perso | `RECORDS` |
| `checkins` | check-in matinal | `checkin` sommeil/fatigue/motivation |
| `videos` | bibliothèque technique | `VIDEOS` |
| `clubs` / `club_groups` / `club_members` | structure club | `CLUB_ATHLETES`, `CLUB_GROUPS` |
| `creneaux` / `creneau_attendees` | créneaux (tarifés) | `CRENEAUX` |
| `subscriptions` | état Stripe | — |

## Mise en route (≈ 30 min)

### 1. Créer le projet Supabase
- supabase.com → New project. Note l'**URL**, l'**anon key** et la **service_role key**
  (Project Settings → API).

### 2. Installer le CLI et lier
```bash
brew install supabase/tap/supabase      # si pas déjà fait
cd ~/pairform-backend
supabase login
supabase link --project-ref VOTRE_REF   # le ref est dans l'URL du projet
```

### 3. Appliquer le schéma
```bash
supabase db push          # joue les migrations 0001 + 0002
```
> Pas de CLI ? Copie-colle le contenu des 2 fichiers `.sql` dans
> Supabase → SQL Editor → Run.

### 4. Configurer Stripe
1. Crée **3 produits** (Coach, Athlète, Club) avec un prix récurrent chacun.
2. Récupère les 3 **Price ID** (`price_...`).
3. Copie `.env.example` → `.env`, renseigne les valeurs.
4. Pousse les secrets :
   ```bash
   supabase secrets set --env-file ./.env
   ```

### 5. Déployer les Edge Functions
```bash
supabase functions deploy stripe-checkout
supabase functions deploy stripe-portal
supabase functions deploy invite-athlete
supabase functions deploy accept-invite
supabase functions deploy creneau-checkout
supabase functions deploy video-url
supabase functions deploy stripe-webhook --no-verify-jwt
```

### 6. Brancher le webhook Stripe
- Stripe → Developers → Webhooks → Add endpoint :
  `https://VOTRE-PROJET.functions.supabase.co/stripe-webhook`
- Événements : `checkout.session.completed`, `customer.subscription.created`,
  `...updated`, `...deleted`.
- Copie le **Signing secret** (`whsec_...`) dans `.env` → `STRIPE_WEBHOOK_SECRET`,
  puis refais `supabase secrets set --env-file ./.env`.
- Test local : `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`

### 7. Brancher le front — ✅ DÉJÀ FAIT
Les deux fichiers HTML (`apex-tri-calendrier.html` et `apex-tri-demo-testeurs.html`)
sont déjà câblés, de façon **non destructive** :

- Un hook `window.__pf_app` est exposé après le boot (donne accès aux globales +
  fonctions de rendu).
- `pairform-integration.js` (couche d'intégration) ajoute un **overlay de
  connexion/inscription** (badge ☁︎ en haut à droite) et, une fois connecté,
  **hydrate les données depuis Supabase** puis re-render.
- **Tant que personne n'est connecté → l'app reste en mode démo** (données en
  dur intactes). Si le backend n'est pas configuré, idem : rien ne casse.

**Pour activer :**
1. Renseigne `SUPABASE_URL` et `SUPABASE_ANON_KEY` dans `pairform-client.js`.
2. Les fichiers `pairform-client.js` et `pairform-integration.js` doivent être
   **à côté des HTML** (déjà copiés dans `~/Downloads/files_extracted/` ; la
   source de vérité reste `~/pairform-backend/web/`).
3. **Sers les fichiers en HTTP** (les modules ES ne se chargent pas en `file://`) :
   ```bash
   cd ~/Downloads/files_extracted && python3 -m http.server 5500
   # puis ouvre http://localhost:5500/apex-tri-calendrier.html
   ```
4. Clique le badge ☁︎ → crée un compte (coach/athlète/club) → l'app se synchronise.
   Lance `select seed_demo(auth.uid());` (étape 8) pour avoir des données.

> ⚠️ Mets `APP_URL=http://localhost:5500` dans `.env` pour les retours Stripe.

Le client `PF` reste utilisable à la main depuis la console (`window.PF`) :
```js
await PF.signUp({ email, password, fullName:'Rowan', role:'coach' });
await PF.startCheckout('coach');         // → redirige vers Stripe
await PF.saveCheckin({ sommeil:7, fatigue:4, motivation:8, readiness:73 });
await PF.scheduleSession(athleteId, '2026-06-24', sessionObj);
const abonne = await PF.isSubscribed();

// Invitations coach → athlète
const { inviteUrl } = await PF.inviteAthlete('athlete@mail.com'); // coach
const tok = PF.pendingInviteToken();                              // athlète (lit ?invite=)
if (tok) await PF.acceptInvite(tok);

// Créneau à la carte (Hyrox) + vidéo premium gated
await PF.payCreneau(creneauId, memberId);     // → redirige Stripe
const url = await PF.getVideoUrl(videoId);    // throw 'premium_required' si pas abonné
```

### 8. (Optionnel) Données de démo
Une fois connecté, dans Supabase → SQL Editor :
```sql
select seed_demo(auth.uid());
```
→ remplit pour ton compte : refs physio, records, check-in, séances de la semaine,
un template coach, et le club « Muret Goat Squad » (groupes + membres + créneaux).

## État de la liste "reste à faire"
- [x] Flux d'**invitation** coach→athlète (par email + token).
- [x] Paiement **créneaux à la carte** (Hyrox, `price > 0`) via Checkout one-shot.
- [x] Storage privé pour les **vidéos premium** + URLs signées selon l'abo.
- [x] Helper de gating (`has_active_subscription` / `PF.isSubscribed`).
- [x] **Brancher les HTML** sur Supabase (hook `__pf_app` + `pairform-integration.js`,
      lecture/hydratation).
- [x] Câbler les **écritures** UI → `PF.*` dans les 2 HTML : valider check-in
      (`saveCheckin`), valider/annuler une séance (`markSessionDone`), supprimer une
      séance (`deleteScheduled`), ranger en bibliothèque (`saveTemplate`), ajouter au
      calendrier (`scheduleSession`), publier un créneau (`saveCreneau`). Tous non
      bloquants et ignorés en mode démo.
- [x] Écritures restantes : **création/édition de groupe** club + affectation des
      membres câblées dans `grpSave` → `PF.saveGroup` / `PF.assignMemberGroup`
      (`club_groups` / `club_members`). Édition des **refs physio** athlète : nouvel
      éditeur dans la sidebar athlète (`#refsBlock`) → `PF.saveAthleteRefs`. Tous non
      bloquants, ignorés en mode démo.
- [x] Envoi **email** réel des invitations via **Resend** (`_shared/email.ts`,
      branché dans `invite-athlete` ; repli sur le lien si pas de clé).
- [x] Gate **UI** premium : cartes vidéo verrouillées (🔒) + lecteur bloqué selon
      `PF.isSubscribed()` (`body.pf-subscribed` / `window.__pf_subscribed`).
- [x] **Synchronisation objets connectés** : migration `0005_device_sync.sql`
      (`device_connections` / `external_activities` / `oauth_states` / vue
      `my_devices`), edge functions `device-connect` / `strava-oauth-callback` /
      `strava-webhook` / `device-sync` / `device-disconnect` (+ `_shared/providers.ts`).
      **Strava complet**. UI de l'app reliée au vrai OAuth (repli démo).
- [x] **Coros** (OAuth2) et **Garmin** (OAuth1.0a) entièrement codés :
      `_shared/coros.ts` / `_shared/garmin.ts` / `_shared/oauth1.ts` (signeur
      HMAC-SHA1 testé, `test/oauth1.test.mjs`), callbacks + webhooks dédiés.
      Boutons Garmin/Coros dans l'app + écran « Activités synchronisées »
      multi-source. En attente des **clés partenaire** pour activation.
- [ ] Uploader les **vidéos** dans le bucket `videos` et renseigner `videos.src`.
- [ ] Affiner la RLS (membres club avec compte, rôles coach dans un club).
- [ ] À réception des clés Garmin/Coros : **ajuster les noms de champs**
      d'activité au format réel de chaque API (normaliseurs déjà défensifs).
