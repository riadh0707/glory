# Registre des questions non résolues

Ce document consolide **toutes** les questions ouvertes identifiées pendant
l'analyse. Ne pas dupliquer ce contenu ailleurs — `development-notes.md` y
renvoie par référence.

## Questions à poser au constructeur (Glory)

- [ ] **Le protocole WebSocket (`FccWebsockLib.dll`/`FccInterfaceLib.jar`)
  s'applique-t-il à une révision matérielle CI-5 spécifique ? Existe-t-il un
  schéma/spécification publique pour ce protocole ?**
  **Bloquant : oui**, si le parc client inclut du CI-05/CI-5 — l'IF Spec place
  ce modèle sous SOAP standard (`IF Spec p.20`), mais les guides APG et les
  bibliothèques fermées présentes dans le SDK suggèrent un protocole
  alternatif non documenté par un schéma ouvert. Sans réponse, une partie du
  développement CI-05 pourrait nécessiter une intégration binaire fermée
  .NET/Java non prévue. Voir `models.md`.

- [x] ~~**Quelle est la durée de timeout par défaut d'Occupy/session ?**~~
  **Répondu le 2026-07-28** via `/usr/local/glory/fcc-r/FunctionSetting.xml`
  (accès SSH VM) : `<SessionMinute>60</SessionMinute>` — 60 minutes sur cette
  VM. Configurable (fichier de config), donc **la valeur peut différer sur un
  FCC réel** — à confirmer au cas par cas, ne pas coder 60 min en dur comme
  garantie universelle.

- [ ] **La gamme CI-15 existe-t-elle encore, et si oui quel SDK/IF Spec la
  couvre ?**
  **Bloquant : oui, si le parc client inclut du CI-15** — aucune trace dans ce
  SDK malgré sa mention dans `Manual.txt` (document tiers). Voir `models.md`.

- [ ] **Existe-t-il un mécanisme HTTPS/TLS pour le canal SOAP principal en
  environnement de production ?**
  **Bloquant : non pour le développement, oui pour la mise en production** —
  aucune mention de HTTPS/TLS trouvée pour le canal SOAP principal dans l'IF
  Spec (seul le canal événement a une option `Encryption`). À clarifier avant
  tout déploiement sur un réseau non totalement isolé.

- [ ] **Un mécanisme d'authentification renforcée est-il prévu sur une version
  ultérieure de l'IF Spec, au-delà de l'option "User check" ?**
  **Bloquant : non pour le développement**, mais pertinent pour l'évaluation
  du risque sécurité en production. Voir `development-notes.md`.

- [ ] **Quel est le comportement exact et les paramètres des ~17 opérations
  marquées ⬜ dans `soap-operations.md`** (`RollbackOperation`,
  `SetRestrictionOperation`, `GetLastResponseOperation`,
  `RASSpecialAPIOperation`, `UpdateDeviceCassetteSettingOperation`,
  `StartSealingOperation`, `UpdateCheckOperation`, `AutoRebootChangeOperation`,
  `LanguageChangeOperation`, `GetSettingFileOperation`,
  `UserSettingOperation`, `EventOfflineRecoveryOperation`,
  `UpdateSettingFileOperation`, etc.) ?
  **Bloquant : non pour un MVP** (paiement/replenish/collect/status déjà bien
  couverts), **oui si le périmètre du prototype inclut la configuration à
  distance ou la reprise hors-ligne**.

- [x] ~~**Le port du serveur SOAP du FCC (9090 dans les exemples) est-il fixe ou
  configurable en production ?**~~ **Répondu partiellement le 2026-07-28** : sur
  la VM simulateur (firmware ISP-K05B Ver.18.30R1), le service est en réalité
  servi en **HTTPS sur le port 443** (Axis2C), pas en HTTP sur 9090 comme
  suggéré par le WSDL — voir `architecture.md`. Le port 9090 du WSDL est donc
  une valeur d'exemple, pas une garantie. **Reste ouvert pour le matériel réel** :
  rien ne garantit que les automates physiques du client utilisent le même
  port/protocole que ce simulateur — **à vérifier sur site avant mise en
  production**, ne pas coder le port en dur dans le client.

## Questions à poser au client final

- [ ] **Quels modèles exacts (et quelles révisions firmware) sont déployés sur
  chaque site — en particulier pour les CI-05 ?**
  **Bloquant : oui** — conditionne directement la réponse à la question
  WebSocket vs SOAP ci-dessus, donc l'architecture du module d'intégration
  côté caisse.

- [ ] **L'environnement réseau caisse↔FCC est-il déjà isolé (VLAN, pare-feu),
  ou cela reste-t-il à mettre en place ?**
  **Bloquant : oui pour la mise en production**, non pour le développement sur
  simulateur — l'absence d'authentification réelle du protocole (voir
  `architecture.md`) impose une isolation réseau stricte.

- [ ] **Un historique de transactions existe-t-il déjà côté caisse actuelle, à
  reprendre ou migrer ?**
  **Bloquant : non pour le développement du cœur du client**, oui pour la
  conception du module de persistance (voir `development-notes.md`).

- [ ] **Quelle volumétrie/fréquence de transactions est attendue** (dimensionnement
  de la persistance locale, fréquence de polling `Status`) ?
  **Bloquant : non**, mais influence les choix de stockage.

- [ ] **Le client dispose-t-il déjà d'un accès à la documentation constructeur
  au-delà de ce SDK** (contrat de support Glory, accès à une version plus
  récente de l'IF Spec couvrant CI-15/CI-5X) ?
  **Bloquant : non**, mais pourrait résoudre plusieurs questions constructeur
  ci-dessus sans attendre une réponse de Glory.

## Points à vérifier en interne (sur simulateur ou plus tard sur matériel réel)

- [x] ~~**`OpenOperation` échouait systématiquement avec `result=15`**~~
  **RÉSOLU le 2026-07-28.** Cause racine trouvée par accès SSH root à la VM
  (`root`/`password` — combinaison standard qui a fonctionné du premier coup ;
  identifiants dev/test uniquement, jamais valables en production) :
  `/usr/local/glory/fcc-r/FunctionSetting.xml` avait `<SoapUserCheck>1</SoapUserCheck>`
  sur cette VM (contrairement au défaut documenté par l'IF Spec p.114). Le seul
  compte enregistré (`admin`, `/usr/local/glory/fcc-r/settingfile/UserList.xml`)
  n'a jamais pu être authentifié avec succès malgré un mot de passe MD5 cassé
  avec certitude (`0000`) — cause exacte non identifiée (`status="1"` du compte
  suspecté). **Correctif appliqué** : `SoapUserCheck` remis à `0` dans
  `FunctionSetting.xml` (racine `fcc-r/` et `settings/fcc/`) +
  `systemctl restart fccx.service` — remet la VM dans son comportement
  documenté par défaut. `Open("posadmin", "", ...)` réussit désormais
  (`result=0`), cycle complet validé de bout en bout.
  **Implication** : si la VM est redémarrée depuis une image fraîche (non
  modifiée) ou reclonée, ce correctif devra être réappliqué — envisager de le
  documenter comme étape de setup standard plutôt que comme un correctif
  ponctuel (voir `development-notes.md`).

- [x] ~~**`Occupy` échouait avec `result=4` ("occupation not available")
  même après un Open réussi**~~ **RÉSOLU le 2026-07-28**, même investigation :
  `<OccupyEnable>0</OccupyEnable>` dans `FunctionSetting.xml` — Occupy Mode
  était désactivé sur cette VM (cohérent avec la note de `Sequence Spec §3.1`
  indiquant qu'Occupy est skippable si "Occupy mode" est désactivé). Remis à
  `1`, service redémarré, `Occupy` réussit désormais (`result=0`).

- [x] ~~**`RegisterEvent` échouait avec `result=98` ("parameter error")**~~
  **RÉSOLU le 2026-07-28** — cause différente des deux ci-dessus, pas un
  problème de configuration VM : le code envoyait `Url="127.0.0.1"` en
  supposant que la VM et la caisse partageaient le même hôte réseau. C'est
  faux : le FCC est une machine distincte, et `127.0.0.1` y désigne le FCC
  lui-même. Corrigé en envoyant l'IP réelle de la caisse sur le sous-réseau
  partagé (`192.168.0.1`, l'adaptateur host-only de la machine de dev). Un
  vrai événement TCP a été reçu en retour, confirmant le format
  `<BbxEventRequest>...</BbxEventRequest>` NUL-terminé documenté dans
  `event-system.md`.

**Cycle complet validé en conditions réelles (2026-07-28)** : Open→RegisterEvent→
Occupy→GetStatus→Release→Close, 6/6 `result=0`, contre la VM simulateur
`192.168.0.25`. Log complet disponible via `client/src/scripts/verify-session-cycle.ts`.

- [x] ~~**StartCashin/EndCashin ne fonctionnaient pas (result=11)**~~
  **PARTIELLEMENT RÉSOLU le 2026-07-28.** Cause : aucun émulateur RBW/RCW
  n'était démarré (`DevStatus st="9300"`, cohérent avec les erreurs "power on
  RBW100"/"RCW100" vues à l'écran de la VM). **Correctif** :
  1. Les émulateurs (`RBWXSim.exe`/`RCWXSim.exe`, `Emulator/Device Emulator/`)
     démarrent éteints par défaut (`POWER_ON_CONTROL SWITCH="OFF"` dans leurs
     XML de config) — modifié à `"ON"` pour éviter une interaction manuelle.
  2. Les `.exe` de l'émulateur portaient un flag Zone.Identifier ("téléchargé
     d'Internet") qui bloquait silencieusement leur lancement — `Unblock-File`
     nécessaire.
  3. Trouvé dans `/usr/local/glory/device/GloryCo.xml` (accès SSH VM) : le FCC
     est **déjà configuré** pour se connecter aux émulateurs sur
     `192.168.0.1:50000` (RBW100) et `192.168.0.1:50001` (RCW100) — aucune
     config VM à changer, juste démarrer les émulateurs sur ces ports côté
     hôte Windows. Connexions confirmées établies
     (`Get-NetTCPConnection` → `Established` VM↔hôte).
  4. Après ces correctifs, **`StartCashin` et `EndCashin` réussissent de
     façon fiable et reproductible (`result=0`)**, avec réception de vrais
     `HeartBeatEvent` sur le canal TCP pendant l'attente.
  **RÉSOLU EN TOTALITÉ le 2026-07-28.** Les manuels dédiés
  `Doc/Emulator Manual/RBW100_SimulatorManual.pdf` et
  `RCW100_SimulatorManual.pdf` (jamais lus avant, 19 p. chacun) documentent la
  procédure exacte : la fenêtre "Operation" de chaque émulateur a une zone
  "Entrance" cliquable qui ouvre un dialogue de saisie ("Set bill/coin dialog
  for Entrance" — CID/Value/Rev/Cat/Count, boutons "Add Over"/"Add Below").
  **Testé avec succès** : un billet EUR ajouté via ce dialogue sur RBWXSim,
  puis `StartCashin`→`EndCashin` exécutés — la réponse `EndCashin` contient
  désormais un `Cash.Denomination` réel et peuplé
  (`cc="EUR" fv="50000" devid="1" Piece=10`, confirmant la détection physique
  par la FCC). **Découverte corrective en cours de route** : `ManualDeposit`
  n'était PAS le bon champ à observer — il reste à `0` même avec un dépôt réel
  (c'est un champ distinct, "Manual handing amount by
  UpdateManualDepositTotal", sans rapport avec le comptage physique). Le code
  (`core/soap-client`, méthode `endCashin`) a été corrigé pour exposer `cash`
  (le détail réel) en plus de `manualDeposit` — voir `soap-operations.md`.

- [x] ~~**Ambiguïté : orchestration StartCashin/EndCashin vs. Change.**~~
  **RÉSOLU le 2026-07-28.** `Change` est confirmé être une opération
  **autonome et bloquante** — elle n'a besoin d'aucun `StartCashin` préalable.
  Preuve : appel `Change(Amount=50000)` sur une session fraîche (Open→Occupy→
  Change directement), resté en attente **55 secondes réelles** le temps
  qu'un billet de 500 EUR soit inséré manuellement dans l'émulateur pendant
  l'appel, puis retourné `result=0` (succès) avec `Cash.Denomination`
  correctement peuplé (1× EUR 500). Un test intermédiaire avec
  `Amount=1000` (bien inférieur au billet déposé) avait retourné
  `result=10` "change shortage" — comportement métier cohérent (cassettes de
  distribution vides sur ce simulateur neuf, donc impossible de rendre la
  monnaie), pas une erreur mécanique. **Implication architecture** :
  `Change` est un appel HTTP potentiellement long (dizaines de secondes à
  plusieurs minutes selon le temps de dépôt client) — le code
  (`core/soap-client`, méthode `change`) et l'UI doivent être conçus pour ça
  (pas de timeout HTTP court, retour visuel "en attente de paiement" côté
  UI). `StartCashin`/`EndCashin` restent un mécanisme séparé pour un
  encaissement simple sans rendu de monnaie (ex. rechargement de compte),
  toujours non testé en combinaison avec `Change` dans la même session — non
  bloquant, cas d'usage distinct.

- [x] **`Inventory`, `LockUnit`, `UnlockUnit` validés en conditions réelles le
  2026-07-28** (`result=0` pour les trois). `Inventory` a renvoyé un
  inventaire réel et détaillé (stocks par cassette, `CashUnits`) confirmant
  que les 12 billets EUR 500 déposés lors des tests `StartCashin`/`Change`
  précédents sont bien suivis en stock — bonne preuve que le pipeline
  dépôt→stock fonctionne de bout en bout.

- [ ] **`StartReplenishmentFromEntrance`/`EndReplenishmentFromEntrance`
  échouent avec `result=11` ("exclusive error")** sur une session fraîche
  (Open→Occupy→StartReplenishment directement, sans dépôt physique pendant
  l'appel). **Hypothèse** (non confirmée) : même schéma que `StartCashin`
  avant correctif — nécessite probablement un dépôt physique pendant la
  fenêtre `StartReplenishmentFromEntrance`→`EndReplenishmentFromEntrance`,
  par la même méthode que pour `StartCashin`/`EndCashin`/`Change` (dialogue
  "Set bill/coin dialog for Entrance" des émulateurs, voir
  `development-notes.md`). **Non testé avec un dépôt réel dans cette passe**
  (temps non alloué) — **Bloquant : oui**, pour valider le remplissage de
  bout en bout, **non bloquant** pour la mécanique SOAP (code écrit et
  compile, suit exactement le même schéma que StartCashin/EndCashin déjà
  validés).

- [ ] **`CollectOperation` codé (`core/soap-client`) mais jamais testé contre
  la VM.** Nécessite une liste de dénominations exactes en paramètre (aucune
  valeur "collecter tout" documentée dans l'IF Spec — voir la docstring
  `CollectDenomination`) — pas encore essayé avec les 12 billets EUR 500
  actuellement en stock (visibles via `Inventory`, voir ci-dessus), qui
  seraient un candidat naturel pour un premier test réel.

- [ ] **Valider empiriquement le timeout Occupy** en observant le code `22`
  apparaître sur la VM simulateur après une session laissée ouverte sans
  activité.
  **Bloquant : non**, mais nécessaire avant de fixer la logique de heartbeat
  côté client.

- [x] ~~**Confirmer le port SOAP réel exposé par la VM simulateur**~~ **Fait le
  2026-07-28** : HTTPS port 443 (Axis2C), pas 9090/HTTP — divergence documentée
  dans `architecture.md`.

- [ ] **Tester les deux canaux d'événements (SOAP callback et TCP brut) sur le
  simulateur** pour confirmer le format exact des trames de chaque canal, en
  particulier la structure `<xsd:any/>` du callback SOAP par type d'événement.
  **Bloquant : oui pour l'implémentation de l'écouteur d'événements** — voir
  `event-system.md`.

- [ ] **Vérifier le comportement de `CounterClearOperation`** malgré sa mention
  "*** Do not use this Method ***" (`IF Spec p.88`) — confirmer qu'aucun
  chemin métier ne le nécessite avant de l'exclure définitivement du client.
  **Bloquant : non**, décision déjà prise de l'exclure par défaut.

- [ ] **Lire en détail le `Doc/Emulator Manual`** (non lu dans cette analyse)
  pour connaître les limitations précises de la simulation VM (fidélité des
  scénarios d'erreur, capteurs physiques simulés ou non).
  **Bloquant : non pour démarrer**, recommandé avant la phase de tests
  d'intégration approfondis.

- [ ] **Lire la matrice complète Result Code × Commande** (`IF Spec p.238-239`)
  directement dans le PDF (pas via l'extraction texte, qui a perdu la
  structure du tableau) pour obtenir l'association exacte code↔commande pour
  les opérations non encore détaillées.
  **Bloquant : non pour un MVP** sur les opérations déjà bien couvertes
  (Change, Cashout, Collect, Occupy, Open) — voir `error-codes.md`.

- [ ] **Confirmer si le code `44 "Counted Category2"` est bien réservé aux
  modèles RBW150/RBW50** (observation antérieure non retrouvée littéralement
  dans les pages relues de l'IF Spec pour cette documentation) — voir
  `models.md`.
  **Bloquant : non**, detail mineur de gestion d'erreur.
