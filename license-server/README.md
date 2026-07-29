# Serveur de licence — Glory FCC Client

Petit serveur (Cloudflare Worker + Workers KV) qui vérifie les clés de
licence du client Electron. Le client contacte `POST /verify` **à chaque
lancement** — pas de mode hors-ligne (voir `docs/development-notes.md`).

## Déploiement (une seule fois)

1. **Créer un compte Cloudflare** (gratuit) sur https://dash.cloudflare.com/sign-up
   si ce n'est pas déjà fait.

2. **Installer les dépendances** :
   ```bash
   cd license-server
   npm install
   ```

3. **Se connecter à Cloudflare** :
   ```bash
   npx wrangler login
   ```
   Ouvre une page dans le navigateur pour autoriser Wrangler.

4. **Créer le namespace Workers KV** (stockage des licences) :
   ```bash
   npx wrangler kv namespace create LICENSES
   ```
   Copie l'`id` affiché et remplace `REPLACE_WITH_KV_NAMESPACE_ID` dans
   `wrangler.toml` par cette valeur.

5. **Définir le jeton admin** (secret, sert à créer/révoquer des licences —
   choisis une chaîne longue et aléatoire, ex. `openssl rand -hex 32`) :
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```
   (Demande la valeur de façon interactive — ne jamais mettre ce jeton dans
   `wrangler.toml` ni le committer.)

6. **Déployer** :
   ```bash
   npm run deploy
   ```
   Affiche l'URL du Worker, du type
   `https://glory-fcc-license-server.<ton-compte>.workers.dev`.

7. **Configurer le client** : remplacer la valeur par défaut de
   `LICENSE_SERVER_URL` dans `client/src/main/main.ts` par cette URL (ou la
   fournir via la variable d'environnement `GLORY_LICENSE_SERVER_URL` au
   build), puis reconstruire/republier le client.

## Gérer les licences

Toutes les commandes ci-dessous nécessitent `WORKER_URL` (l'URL obtenue à
l'étape 6) et `ADMIN_TOKEN` (le secret défini à l'étape 5) en variables
d'environnement.

**Créer une nouvelle licence** (avec date d'expiration) :
```bash
WORKER_URL=https://glory-fcc-license-server.<compte>.workers.dev \
ADMIN_TOKEN=<jeton admin> \
node scripts/create-key.js "Nom du client" 2027-01-01
```
Affiche la clé générée (format `GLORY-XXXX-XXXX-XXXX-XXXX`) à transmettre au
client.

**Révoquer une licence** (immédiat, plus besoin d'attendre l'expiration) :
```bash
WORKER_URL=https://glory-fcc-license-server.<compte>.workers.dev \
ADMIN_TOKEN=<jeton admin> \
node scripts/revoke-key.js GLORY-XXXX-XXXX-XXXX-XXXX
```

**Lister toutes les licences actives** (via la CLI Wrangler directement,
pas d'endpoint HTTP dédié) :
```bash
npx wrangler kv key list --binding=LICENSES --remote
```

## Développement local

```bash
npm run dev
```
Lance un serveur local sur `http://127.0.0.1:8787`, avec une base KV locale
séparée (fichiers sous `.wrangler/`, jamais synchronisée avec la vraie base
en ligne). Pratique pour tester le client sans toucher aux vraies licences —
pointer `GLORY_LICENSE_SERVER_URL=http://127.0.0.1:8787` au lancement du
client Electron.

**Piège rencontré (2026-07-29)** : dans certains environnements (VM/sandbox
détectés comme "AI agent" par Wrangler), les secrets définis dans
`.dev.vars` ne sont pas correctement injectés dans `env` malgré le message
"Using secrets defined in .dev.vars" et le tableau de bindings qui les
affiche — `env.ADMIN_TOKEN` reste `undefined`, cassant les routes
`/admin/keys`. Contournement utilisé pour valider le reste du système :
insérer des enregistrements de test directement via
`npx wrangler kv key put --binding=LICENSES --local "CLE" '{"clientName":"...","expiresAt":"...","revoked":false}'`
plutôt que via `/admin/keys`. Ce piège n'affecte que le développement local
dans cet environnement précis — `wrangler secret put` en production (étape 5
ci-dessus) est la voie standard et fonctionne normalement.
