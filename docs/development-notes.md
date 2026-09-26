# Notes pour le développement

Ce document rassemble les pièges découverts, les contradictions de
documentation, les bonnes pratiques déduites, les hypothèses restantes et les
décisions d'architecture recommandées. Pour la liste des questions ouvertes,
voir **[open-questions.md](open-questions.md)** — non dupliquée ici.

## Pièges découverts

1. **Plusieurs copies de `BrueBoxService.wsdl` coexistent dans le SDK**, avec un
   nombre d'opérations variable (18 à 49 selon la copie embarquée dans
   `App/PosSimple*`). **Toujours utiliser la copie racine**
   (`F:\SDK_ISPK05B_v1830_20230620\BrueBoxService.wsdl`), la plus complète
   (53 opérations confirmées par grep direct — voir `soap-operations.md`).
   Ne jamais générer de stub client à partir d'une copie embarquée dans un
   exemple sans vérifier sa date/complétude d'abord.

2. **`Manual.txt` n'est pas un document Glory** — c'est le manuel de
   "CI-Activate", un outil tiers développé par un partenaire Glory (auteur
   Tiago Costa). Il reste utile en recoupement (ex. visibilité du menu Unlock
   par modèle) mais ne doit jamais être cité comme source primaire dans le
   code ou la documentation métier — toujours préférer l'IF Spec ou le WSDL
   quand une information existe dans les deux.

3. **`CounterClearOperation` est explicitement dépréciée** dans l'IF Spec :
   « *** Do not use this Method *** » (`p.88`). Elle apparaît pourtant dans le
   WSDL et dans la Result Code Matrix — ne pas l'implémenter dans le client
   sans raison métier explicite et validée.

4. **Le `TransactionId` n'est pas toujours dans la réponse SOAP synchrone.**
   En mode par défaut, il est livré via le canal événement, pas dans la
   réponse directe de `Change`/`Cashin`/`Cashout`/`Collect` (annotation
   récurrente dans l'IF Spec). Un client qui ignorerait le canal événement
   perdrait la capacité de corréler ses transactions — **le canal événement
   n'est donc pas optionnel pour un usage transactionnel sérieux**, même si le
   protocole permet techniquement de fonctionner sans `RegisterEvent`.

5. **`Status` ne doit pas être appelé en polling continu** — le constructeur
   le déconseille explicitement (`IF Spec p.36`). Le design attendu est
   événementiel (`RegisterEvent` + écoute), pas du sondage périodique agressif.

6. **Les diagrammes de séquence du PDF `Sequence Spec` sont des graphiques
   vectoriels**, pas du texte — une extraction `pdftotext` ne récupère que les
   sections "Outline" en prose et, par chance, la séquence 3.1 (assez simple
   pour avoir été rendue en texte). Pour toute séquence détaillée non couverte
   dans `session-lifecycle.md` (Pre Cash In, Change, Cash Out, Replenishment,
   Collect...), il faudra rouvrir le PDF original en mode image/visuel, pas
   seulement en extraction texte.

7. **L'attribut `result` d'une réponse SOAP n'est pas toujours accessible en
   `response.result` avec la lib `soap` (node-soap).** Le WSDL déclare `result`
   comme un attribut XML (`<xsd:attribute ref="xsd1:result"/>`), et le serveur
   Axis2C de la VM le renvoie avec un préfixe de namespace
   (`attributes["n:result"]`, vérifié empiriquement le 2026-07-28), pas à plat.
   `core/soap-client/index.ts` centralise l'extraction dans
   `extractResultAttribute()` — ne jamais lire `response.result` directement
   dans une nouvelle opération sans passer par cette fonction.

8. **`rejectUnauthorized` au niveau racine de `soap.IOptions` n'est PAS
   forwardé** à la couche de transport HTTPS par la lib `soap` 1.10.x (elle
   utilise axios en interne). Pour un FCC à certificat auto-signé (cas de la
   VM), il faut fournir sa propre instance axios via l'option `request` avec
   un `https.Agent({ rejectUnauthorized: false })` — voir
   `core/soap-client/index.ts`, méthode `create()`.

9. **RÉSOLU — `OpenOperation`/`Occupy`/`RegisterEvent` échouaient tous les
   trois sur la VM simulateur, pour trois raisons indépendantes.** Détail
   complet et statut dans [open-questions.md](open-questions.md) (section
   "Points à vérifier en interne", entrées cochées 2026-07-28). Résumé pour
   mémoire :
   - `Open` (`result=15`) : `SoapUserCheck=1` dans
     `/usr/local/glory/fcc-r/FunctionSetting.xml` sur la VM (contraire au
     défaut documenté par l'IF Spec). Remis à `0` + `systemctl restart
     fccx.service`. **Si la VM est reclonée/reprovisionnée, ce correctif doit
     être réappliqué** — à envisager comme étape de setup standard du
     simulateur plutôt qu'un correctif ponctuel oublié.
   - `Occupy` (`result=4`) : `OccupyEnable=0` sur la même VM, même fichier.
     Remis à `1`.
   - `RegisterEvent` (`result=98`) : **bug réel du code**, pas une config VM —
     `url: "127.0.0.1"` supposait à tort que la caisse et le FCC partagent le
     même hôte réseau. Le FCC est toujours une machine distincte (même en VM) ;
     `127.0.0.1` y désigne le FCC lui-même. **Toujours utiliser l'IP réelle de
     la caisse sur le sous-réseau partagé avec le FCC**, jamais `127.0.0.1` ni
     `localhost`, dans `RegisterEvent`/`UnRegisterEvent`.
   - Accès diagnostic : SSH root sur la VM (`root`/`password`, port 22) a
     permis d'inspecter `/usr/local/glory/fcc-r/FunctionSetting.xml` et
     `/var/log/glylog/GLOG_BrueBoxService.log` (log clair de chaque requête/
     réponse SOAP côté FCC — très utile pour diagnostiquer un futur problème
     similaire). **Ces identifiants sont valables uniquement sur cette VM de
     développement/test, jamais sur un FCC de production.**
   - Cycle complet revalidé de bout en bout après ces trois correctifs :
     Open→RegisterEvent→Occupy→GetStatus→Release→Close, 6/6 `result=0`
     (`client/src/scripts/verify-session-cycle.ts`).

10. **Procédure pour démarrer les émulateurs RBW-100/RCW-100** (à refaire à
    chaque nouvelle session de travail — ni la VM ni Windows ne les relancent
    automatiquement) :
    1. Extraire un des zips `Emulator/Device Emulator/RBW-100/RBW-100_Release_*.zip`
       (choisir la devise/variante adaptée — EUR utilisé ici, cohérent avec la
       config EUR de la VM trouvée dans `GloryCo.xml`).
    2. Dans le XML de config de chaque émulateur (`RBWXSimConfiguration.xml`,
       `RCWXSimConfiguration.xml`), mettre `POWER_ON_CONTROL SWITCH="ON"`
       (défaut `"OFF"` — évite un clic manuel de mise sous tension à chaque
       lancement). **Modification appliquée directement dans le fichier
       vendeur `Emulator/Device Emulator/RCW-100/RCWXSimConfiguration.xml`** —
       à savoir si le SDK est re-copié depuis une source propre.
    3. `Unblock-File` sur les deux `.exe` (marqués Zone.Identifier "téléchargé
       d'Internet" par Windows, ce qui bloque leur lancement silencieusement).
    4. Lancer `RBWXSim.exe` et `RCWXSim.exe` — ils écoutent respectivement sur
       les ports TCP **50000** et **50001** côté hôte Windows.
    5. Le FCC (VM) est déjà configuré pour s'y connecter automatiquement sur
       `192.168.0.1:50000`/`:50001` (`/usr/local/glory/device/GloryCo.xml`,
       aucune modification nécessaire côté VM) — si la connexion ne se fait
       pas seule, `systemctl restart fccx.service` sur la VM force une
       reconnexion (`Get-NetTCPConnection -LocalPort 50000,50001` côté
       Windows doit passer à l'état `Established`).
    6. Si un appel SOAP bloque l'appareil dans un état incohérent (ex. un
       `Change` resté en attente puis interrompu côté client), un `Reset`
       (`ResetOperation`, session Occupied) suffit à le ramener à l'état prêt.
    - **Résolu (voir `open-questions.md`)** : insertion de billet/pièce via le
      dialogue "Set bill/coin dialog for Entrance", ouvert en cliquant la zone
      "Entrance" de la fenêtre "Operation" de chaque émulateur
      (`RBW100_SimulatorManual.pdf`/`RCW100_SimulatorManual.pdf`, jamais lus
      avant d'en avoir besoin — toujours consulter ces manuels dédiés avant
      de suspecter un bug côté client SOAP quand un appel échoue de façon
      répétée sur simulateur).
    - **Piège découvert (2026-07-29) — manipuler la porte/cassette de
      collecte du RBW-100 via l'émulateur est risqué et potentiellement
      irréversible sans redémarrage VM.** Séquence
      UnlockUnit→"Door Set"→"Stack Cst"→"Door Set" (pour tester `Collect`) a
      laissé l'émulateur dans un état où `Inventory`/`Collect` échouent en
      permanence avec `result=11`, résistant à `Reset` ET à
      `systemctl restart fccx.service` (les deux avaient toujours suffi
      jusque-là). Nouveau code `DevStatus.st="9100"` observé (probablement
      "porte ouverte", non documenté dans l'IF Spec lu à ce jour). **Avant de
      reproduire cette manipulation, envisager un snapshot VMware de la VM**
      (`vmrun snapshot`) pour pouvoir revenir en arrière sans tout
      reconfigurer (SoapUserCheck, OccupyEnable, etc.).
    - **Règle de sécurité pour le code client, issue du scénario "billet
      catégorie 2/3" (2026-07-29, retesté et tranché le même jour — voir
      `open-questions.md`)** : après tout appel qui peut détecter une
      anomalie physique (`StartCashin`, `EndCashin`, `Change`...), **toujours
      relire `GetStatus` avant d'enchaîner sur l'opération de clôture
      normale**, et si `Status.Code` ∈ {6, 13, 24, 30} (erreur/billet
      cat.2-3/attente de retrait), **ne jamais appeler `EndCashin` ni
      `CashinCancel`** — les deux ont été confirmés bloquer indéfiniment le
      simulateur dans cet état (pas spécifique à `EndCashin`, retest avec
      `CashinCancelOperation` reproduit le même hang). Le flux correct
      documenté (Sequence Spec §3.19) est `OpenExitCover` directement après
      détection d'erreur ; sur ce simulateur, même cet appel échoue
      proprement avec `result=11` (pas de hang) sans jamais réussir — limite
      de fidélité du simulateur RBW-100, cohérente avec le disclaimer déjà
      documenté pour `Collect`. **Si `OpenExitCover` échoue à cet état, ne
      pas insister avec d'autres opérations de clôture** : escalader vers une
      intervention manuelle plutôt que de risquer un blocage matériel qui,
      lui, peut nécessiter un redémarrage.
    - **Découverte sur la récupération d'un blocage RBW-100 (2026-07-29)** :
      un redémarrage complet de la VM **ne suffit pas toujours** à nettoyer
      un état bloqué — `RBWXSim.exe`/`RCWXSim.exe` tournent comme processus
      **hôte** (Windows), séparés de la VM, et conservent leur état interne
      (ex. un billet resté "coincé") à travers un reboot VM. Récupération
      fiable observée : (1) `systemctl restart fccx.service` sur la VM via
      SSH, **puis** (2) tuer et relancer le process `RBWXSim.exe`/
      `RCWXSim.exe` concerné sur l'hôte. Cette combinaison a résolu un
      deuxième blocage identique sans nécessiter de reboot VM complet.

## Bugs UI corrigés (2026-07-29)

Les cartes de `ui/index.html` ont été ajoutées incrémentalement session après
session (Session, Encaissement, Remplissage, Supervision, Annulation,
Dénominations...) sans jamais revérifier le CSS de layout — à ~7 cartes, deux
bugs visuels sont apparus, diagnostiqués via capture d'écran réelle (CDP
`Page.captureScreenshot`, pas une supposition) :

1. **`.col-left` n'avait pas de scroll.** Avec `display:flex;flex-direction:
   column` et `.card{min-height:0}` mais sans hauteur totale suffisante, le
   navigateur réduisait (flex-shrink) chaque carte en dessous de la hauteur de
   son propre contenu — le contenu (boutons, labels) débordait alors
   visuellement de sa carte et chevauchait la carte suivante, au lieu de
   simplement dépasser proprement. **Correctif** : `.col-left{overflow-y:auto}`
   + `.card{flex-shrink:0}` par défaut (les cartes gardent leur taille
   naturelle, la colonne défile) ; la carte "Statut (JSON)", seule à devoir
   remplir l'espace restant, utilise la nouvelle classe `.card--fill` au lieu
   d'un style inline `flex:1`.
2. **`.events-panel{flex:none;height:180px}` écrasait `.log-panel` à une
   hauteur quasi nulle** sur une fenêtre basse (`.col-right` trop petite pour
   180px fixes + le reste) — le texte du titre "Journal" débordait visible­ment
   de sa boîte de 2px. **Correctif** : les deux panneaux ont maintenant un
   `min-height` (90px) et peuvent rétrécir l'un vers l'autre au lieu que l'un
   soit rigide et l'autre écrasé ; `.col-right` a aussi gagné `overflow-y:auto`
   en filet de sécurité.

**Nettoyage associé** : tous les styles inline `style="..."` répétés sur les
`<input>`/`<label>`/lignes de champs (ajoutés au fil des sessions, jamais
factorisés) ont été remplacés par des classes CSS (`.field-label`,
`.field-row`, `input[type="text"]` global) — en plus de la cohérence visuelle,
ça corrige un second problème de redimensionnement : les inputs en ligne
(`.field-row`) n'avaient pas `min-width:0`, donc plusieurs champs côte à côte
pouvaient forcer la carte (et la fenêtre) à s'élargir au lieu de rétrécir
proprement.

**Validé** aux tailles 320×600, 500×400, 900×650 (défaut) et 1400×900 via
`Emulation.setDeviceMetricsOverride` (CDP) — plus aucun débordement horizontal
ou vertical au niveau de la page (`document.body.scrollHeight`/`scrollWidth`
== `window.innerHeight`/`innerWidth` dans les quatre cas), fonctionnalité
(Connecter/Déconnecter) revérifiée intacte après le changement de CSS.

## Rapport de diagnostic (2026-07-29) — préparation du test sur matériel réel

Objectif : quand le client testera contre un vrai FCC (pas la VM simulateur),
il doit pouvoir signaler un problème sans avoir à décrire lui-même la
séquence d'appels ou copier des logs à la main. Trois ajouts pour ça :

1. **Toute erreur est maintenant persistée**, pas seulement affichée. Avant
   ce changement, les lignes `[ERREUR]` n'existaient que dans le panneau de
   log de l'UI (perdues à la fermeture de l'app). `sendLog` (main.ts)
   détecte le préfixe `[ERREUR]` et l'enregistre aussi dans `HistoryStore`
   (nouveau type d'événement `error`).
2. **Filets de sécurité pour les erreurs non anticipées**, à trois niveaux :
   `process.on("uncaughtException"/"unhandledRejection")` côté main,
   `window.onerror`/`unhandledrejection` côté renderer (remontés au main via
   IPC `diagnostic:report-renderer-error`), et chaque handler de clic UI est
   maintenant enveloppé (`guardedClick` dans `renderer.ts`) pour que le
   bouton se réactive **toujours** (`finally`) même si son handler lève une
   exception — corrige au passage la classe de bug rencontrée le 2026-07-29
   sur `btn-disconnect` (bouton resté bloqué après une exception silencieuse,
   aucune trace nulle part).
3. **`core/diagnostic-report`** génère, sur demande (bouton "Générer rapport
   de diagnostic", carte Session), deux fichiers dans
   `client/data/reports/<horodatage>/` (dossier gitignored, jamais commité) :
   `report.json` (export brut de tout l'historique `HistoryStore` — y
   compris les sessions précédentes, la base SQLite persiste entre
   lancements) et `report.md` (résumé lisible : environnement,
   compteurs par opération/code résultat, liste chronologique des erreurs,
   puis le journal complet). Testé réel : génère correctement un rapport de
   450 événements avec extraction correcte des codes résultat (les réponses
   SOAP sont journalisées **brutes** dans `HistoryStore` — `result` est sous
   `attributes["n:result"]`, pas à plat — piège reproduit dans
   `describeResultCode()`, la même astuce que `extractResultAttribute` dans
   `core/soap-client`).

## Contradictions de documentation (résolues ou non)

| Contradiction apparente | Statut | Détail |
|---|---|---|
| Callback SOAP (`EventService.wsdl`) vs socket TCP brut (code `PosSimple`) pour les événements | **Résolue** | Les deux sont officiellement supportés simultanément (`Sequence Spec §2.1`, `IF Spec p.90`) — voir `event-system.md`. Ce n'était pas une divergence doc/code. |
| CI-5 sous SOAP (IF Spec) vs bibliothèques WebSocket fermées (guides APG) | **Non résolue** | Voir `models.md` et `open-questions.md` — question bloquante à poser au constructeur. |
| CI-15 mentionné dans `Manual.txt` (tiers) mais absent de toute doc Glory du SDK | **Non résolue, mais tranchée pour le développement** | Traiter CI-15 comme non couvert par ce SDK tant qu'aucune documentation constructeur dédiée n'est fournie — voir `models.md`. |

## Bonnes pratiques déduites de la documentation

- Toujours encadrer une session par `Open`→`Occupy`→...→`Release`→`Close`,
  même si le protocole permet de les ignorer en configuration "Session
  mode"/"Occupy mode" désactivés — ne pas s'appuyer sur cette exception en
  production sans confirmation explicite de la configuration serveur.
- Traiter les erreurs `21`/`22` (session invalide/timeout) comme un signal de
  réouverture de session, pas comme une erreur fatale à remonter directement
  à l'opérateur.
- Distinguer explicitement, dans le code, les erreurs auto-récupérables
  (attendre l'événement de fin d'auto-récupération, `Sequence Spec §3.3`) des
  erreurs nécessitant un `Reset` manuel — ne pas les traiter de façon uniforme.
- Ne jamais construire de logique métier sur le seul nom d'une opération
  marquée ⬜ dans `soap-operations.md` — vérifier l'IF Spec avant de l'utiliser.

## Hypothèses restantes (à confirmer avant du code de production)

- Le port SOAP `9090` est une valeur d'exemple observée dans les WSDL, non une
  garantie de configuration constructeur pour tout déploiement.
- Le format exact des trames TCP brutes du canal événement (NUL-terminées,
  port ~55561/55562) est déduit du code d'exemple `PosSimple`, pas de l'IF
  Spec elle-même — à valider sur simulateur avant implémentation finale.
- L'association code `44`↔RBW150/RBW50 est une observation non retrouvée
  littéralement dans les pages relues de l'IF Spec pour cette documentation.

## Décisions d'architecture recommandées

(Résumé — le détail complet reste dans l'artefact "Étude technique" livré
précédemment ; ce document sert de rappel synthétique pour la phase de
développement.)

- **Isoler le transport SOAP derrière une interface**, générée/maintenue à
  partir de la copie racine de `BrueBoxService.wsdl` (voir piège n°1
  ci-dessus).
- **Implémenter les deux mécanismes d'événements** (callback SOAP et socket
  TCP) derrière une interface commune, sélectionnable via configuration
  (`RegisterEvent` avec `Url`/`Port` appropriés) — voir `event-system.md`.
- **Modéliser explicitement une machine à états de session**
  (`Closed → Open → Occupied → Released → Closed`) qui rejette toute
  opération métier hors de l'état `Occupied`.
- **Construire une couche de persistance locale des transactions**
  (`TransactionId` + événements corrélés) dès le départ — le FCC n'offre
  aucun historique, ce n'est pas une fonctionnalité différable.
- **Ne pas répliquer les exemples `App/PosSimple` tels quels** : ils sont
  fournis comme preuve de consommation du WSDL, pas comme base de code à
  industrialiser (Windows/.NET Framework legacy pour la plupart).

## Packaging Windows/Linux (2026-07-29) — exception à la règle "ne pas versionner le SDK constructeur"

`.gitignore` exclut délibérément le contenu volumineux fourni par Glory
(`/App/`, `/Doc/`, `/Emulator/`, `/*.wsdl`, `/*.pdf`, ~5,3 Go). Ça a cassé le
build CI (GitHub Actions) : `client/package.json` copiait
`BrueBoxService.wsdl` depuis la racine du SDK au moment du build, un fichier
qui n'existe donc pas dans un checkout Git propre. **Exception délibérée** :
une copie de `BrueBoxService.wsdl` (168 Ko, le seul fichier réellement
nécessaire à l'exécution du client, pas à sa documentation) est maintenant
versionnée dans `client/resources/BrueBoxService.wsdl` et copiée vers
`dist/resources/` au build — voir aussi la docstring `WSDL_PATH` dans
`core/soap-client/index.ts`. Le reste du SDK (Doc/, Emulator/, App/) reste
non versionné, cette exception est strictement limitée à ce seul fichier.

Deux bugs de packaging supplémentaires, trouvés en testant l'exécutable réel
généré (`release/win-unpacked/*.exe`), sont documentés dans le message du
commit correspondant : `DATA_DIR` (main.ts) doit utiliser
`app.getPath("userData")`, jamais un chemin relatif à `__dirname` (qui pointe
dans `app.asar`, en lecture seule une fois empaqueté).

**Limitation connue** : la génération de paquets Linux (AppImage/.deb) n'est
pas fiable depuis un hôte **Windows** avec electron-builder — l'outil
AppImage tente d'utiliser un binaire macOS (`darwin/mksquashfs`) même sur
Windows, et `.deb` nécessite `fpm` (Ruby), absent de Windows. Solution
retenue : `.github/workflows/build-client.yml`, qui construit Windows et
Linux chacun sur son runner natif (déclenchement manuel ou tag `v*`).

## Système de licence (2026-07-29)

Architecture : `license-server/` (Cloudflare Worker + Workers KV, voir son
README.md pour le déploiement/la gestion des clés) + `client/src/core/license/`
(vérification côté client). Le client Electron **doit** contacter le serveur
de licence en ligne à **chaque lancement** (pas de mode hors-ligne/grâce —
demande explicite du client) : `main.ts` charge d'abord `license.html`
(écran d'activation) et ne charge `index.html` (l'app réelle) qu'après
validation réussie via `gateOnLicense()`. Licence stockée localement
(`userData/license.json`) seulement pour préremplir la revérification
suivante, jamais pour contourner l'appel réseau.

**Bug trouvé en testant** (pas juste en supposant que ça marche) : le module
`core/license` utilisait initialement `https.request` en dur pour appeler le
serveur de vérification. Fonctionne contre le Worker déployé (toujours en
`https://`), mais échoue silencieusement (timeout → "network-error") contre
un serveur de test local (`wrangler dev`, en `http://127.0.0.1:8787`) — le
module `https` de Node ne sait pas parler HTTP en clair. Remplacé par
`axios` (déjà une dépendance du projet, utilisée par `core/soap-client`),
qui gère les deux protocoles de façon transparente.

**Piège d'environnement local** : voir `license-server/README.md`,
section "Développement local" — `wrangler dev` dans cet environnement précis
n'injecte pas correctement `.dev.vars` dans `env` (probablement lié à la
détection "AI agent" par Wrangler), cassant les routes admin protégées par
`ADMIN_TOKEN` en test local uniquement. Contourné en testant `/verify`
(le seul endpoint dont dépend le client) via des enregistrements insérés
directement en KV local (`wrangler kv key put --local`). N'affecte pas le
déploiement réel (`wrangler secret put` fonctionne normalement en
production).

**Validé réel** (contre un `wrangler dev` local, KV peuplé manuellement) :
écran d'activation bloque sans clé ; clé inconnue rejetée avec message clair ;
clé valide → accès à l'app + licence stockée ; serveur injoignable au
lancement suivant (même avec licence stockée valide) → accès bloqué avec
message clair et bouton "Réessayer" ; "Réessayer" une fois le serveur
de nouveau joignable → débloque sans re-saisir la clé.

**Reste à faire** : déployer le Worker pour de vrai (compte Cloudflare du
client, voir `license-server/README.md`) et mettre à jour
`LICENSE_SERVER_URL` dans `main.ts` avec l'URL réelle avant toute
distribution au client final — la valeur actuelle est un placeholder
(`https://glory-fcc-license-server.example.workers.dev`, ne répond à rien).

## Backlog — opérations SOAP potentiellement à ajouter plus tard

État au 2026-07-29 : 33 des 53 opérations du WSDL sont implémentées dans
`core/soap-client` (session, paiement/annulation, remplissage, collecte,
déverrouillage, supervision/diagnostic, gestion des dénominations — tout ce
que le client a explicitement demandé). Les 20 restantes n'ont **pas** été
implémentées car hors du périmètre exprimé jusqu'ici — listées ici pour
référence future, à activer sur demande explicite plutôt que par anticipation :

- **Déploiement / configuration machine** (impact machine potentiellement
  large, à traiter avec prudence) : `StartDownloadOperation` (déploiement
  paquet langue/devise), `UpdateCheckOperation`, `UpdateSettingFileOperation`,
  `GetSettingFileOperation` variantes d'écriture, `LanguageChangeOperation`,
  `AutoRebootChangeOperation`, `UpdateDeviceCassetteSettingOperation`,
  `UserSettingOperation` (création/suppression d'utilisateurs FCC).
- **Redémarrage/alimentation** : `PowerControlOperation` (reboot/arrêt du
  FCC — codé pour reference dans `soap-operations.md` mais jamais appelé
  contre la VM, effet destructif évident).
- **Diagnostics avancés** : `StartLogreadOperation` (lecture logs
  techniques), `GetLastResponseOperation` (rejeu dernière réponse),
  `RASSpecialAPIOperation` (fonction non identifiée), `RefreshSalesTotalOperation`,
  `UpdateManualDepositTotalOperation`.
- **Cassette scellée** : `StartSealingOperation` (RBW-150 uniquement,
  IF Spec).
- **Événements** : `UnRegisterEventOperation` (symétrique de RegisterEvent,
  jamais nécessaire dans ce prototype qui garde une seule destination
  active toute la session), `EventNotificationStatusOperation`,
  `EventOfflineRecoveryOperation` (réservé CI-Server).
- **Explicitement exclu, pas juste différé** : `CounterClearOperation` —
  marqué "*** Do not use this Method ***" dans le WSDL lui-même.

## Mise à jour 2026-09-26 — retrait du système de licence, UI orientée client final

Suite aux retours du client réel (bring-up matériel terminé avec succès, voir
plus haut) et à une demande de fonctionnalités concrètes côté UI :

- **Système de licence entièrement retiré** (pas seulement désactivé) :
  `client/src/core/license/`, `client/src/ui/license.html`/`license.ts`, et
  tout le dossier `license-server/` (Cloudflare Worker) ont été supprimés du
  dépôt, ainsi que tous les canaux IPC/handlers associés dans `main.ts`,
  `preload.ts`, `ipc-channels.ts`, `global.d.ts`. Décision explicite du
  client : « on en aura pas besoin [pour l'instant] ». L'app charge
  désormais toujours `index.html` directement au démarrage
  (`createWindow()` → `loadMainApp()`, plus de branchement conditionnel).
  Si le besoin de licence revient, repartir de l'historique git (commit
  `7ba1aeb` et suivants) plutôt que de reconstruire à partir de zéro — la
  logique de vérification en ligne / stockage local y était déjà correcte
  et testée.

- **UI réorganisée autour d'un "mode technique" masquable** (attribut
  `data-tech` + classe `.tech-on` sur `.app`, bouton "Mode technique" dans le
  header, préférence mémorisée en `localStorage`). Tout ce qui ressemble à du
  code/log brut pour un utilisateur final (panneau JSON `#status-output`,
  journal SOAP brut, événements TCP bruts, dénominations cc/fv/devid, taux de
  change, cashout manuel, lecture de fichier de config) est masqué par défaut
  mais reste entièrement fonctionnel — accessible en un clic pour le support.
  Rien n'a été supprimé fonctionnellement, seulement caché par défaut.

- **Inventaire lisible** : nouvelle fonction `extractInventoryLines()` +
  `flattenCashDenoms()` dans `main.ts` — parse la réponse XML→JS brute
  d'`InventoryOperation` (`Cash.Denomination` et `CashUnits[].CashUnit[].
  Denomination`, deux niveaux d'imbrication différents selon le champ, voir
  WSDL lignes 390-401/560-574) et regroupe par devise/valeur faciale pour un
  tableau simple (billets/pièces + total) affiché côté renderer
  (`aggregateDenoms()`, `denomTableHtml()`). Le JSON brut reste disponible en
  mode technique.

- **Rapport du jour** (`handleDayReport()`, canal IPC
  `diagnostic:day-report`) : agrège les événements `historyStore` du jour
  courant pour les opérations qui manipulent des espèces (`Change`,
  `EndCashin`, `Cashout`, `EndReplenishmentFromEntrance`,
  `CashinCancel`, `ReplenishmentFromEntranceCancel`) en un résumé par
  opération/devise. **Distinct du rapport de diagnostic** (`generateDiagnosticReport`,
  volontairement conservé tel quel — outil de support technique, pas un
  document pour le client). Piège évité : le logger interne de
  `FccSoapClient.call()` écrit déjà une entrée `soap-response` brute (sans
  `resultDescription`) pour CHAQUE appel, en plus de l'entrée typée écrite
  par chaque `handleXxx` de `main.ts` — `handleDayReport()` ne doit lire que
  les entrées typées (discriminées par la présence de `resultDescription`)
  sous peine de compter les opérations en double.

- **Impression via le dialogue système** (`printHtml()` dans `renderer.ts` +
  `#print-area` masqué + règle `@media print` dans `styles.css`, qui masque
  tout sauf `#print-area` au moment de l'impression). Décision explicite du
  client : utiliser l'impression standard du système (`window.print()`),
  pas d'intégration pilote spécifique — Windows/Linux/le navigateur gèrent
  le choix de l'imprimante. Trois usages : reçu de transaction (après
  Démarrer/Terminer encaissement, Change, Annulation), inventaire, rapport
  du jour.

- **Fonctionnalité explicitement mise de côté** : « scanner un ticket pour
  obtenir son prix » — le FCC (API SOAP BrueBoxService) ne gère ni scanner
  ni catalogue de prix, c'est un boîtier de gestion d'espèces, pas une
  caisse produit. Nécessite une clarification du client (source des prix :
  fichier ? logiciel de caisse existant ?) avant toute implémentation — voir
  `open-questions.md` si cette demande revient.

## Points à vérifier avant le matériel réel

Voir la section dédiée dans **[open-questions.md](open-questions.md)**
("Points à vérifier en interne (sur simulateur ou plus tard sur matériel
réel)") — non dupliquée ici.
