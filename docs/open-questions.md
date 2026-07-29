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

- [x] ~~**`StartReplenishmentFromEntrance`/`EndReplenishmentFromEntrance`
  échouaient avec `result=11`**~~ **VALIDÉ le 2026-07-29** avec un vrai dépôt
  (2 billets EUR 500 + 5 pièces de 2 EUR insérés via les dialogues "Entrance"
  des émulateurs RBW-100/RCW-100) : `EndReplenishmentFromEntrance` a réussi
  (`result=0`) avec `Cash.Denomination` correctement peuplé pour les deux
  dispositifs (billets **et** pièces) — même mécanique de détection que
  `StartCashin`/`Change`, confirmée pour le remplissage. Après coup,
  `Status`/`Inventory` confirment l'appareil propre (`st=1000`,
  `Inventory` → `result=0`).
  **Point non résolu (mineur)** : `StartReplenishmentFromEntrance` a échoué
  une fois avec `result=11` juste avant ce succès (sur une tentative
  précédente où l'insertion n'avait apparemment pas été détectée par
  `EndReplenishmentFromEntrance`, `Cash` vide) — puis a de nouveau échoué au
  redémarrage du cycle suivant, alors que `EndReplenishmentFromEntrance`
  appelé juste après a quand même réussi et récupéré tout ce qui avait été
  déposé entre-temps. Hypothèse non confirmée : `StartReplenishmentFromEntrance`
  échoue si un dépôt est déjà en attente à l'entrée d'une tentative
  précédente non finalisée (comportement plausible, pas vérifié). **Non
  bloquant** — `EndReplenishmentFromEntrance` seul suffit à récupérer le
  dépôt même quand `Start` échoue, donc la fonctionnalité reste utilisable en
  pratique.

- [ ] **`CollectOperation` testé le 2026-07-29 contre les 12 billets EUR 500
  réellement en stock — échoue avec `result=11` ("exclusive error"), de façon
  reproductible même après un `Reset` explicite** (qui confirme bien
  l'appareil "prêt", `st=1000`, donc ce n'est pas un état résiduel comme
  StartCashin l'était avant correctif). La réponse contient
  `Cash[0].attributes = {type:"8", note_destination:"CollectionUnit",
  coin_destination:"COFB"}` — cohérent avec l'IF Spec p.83 ("type 8 = Collect
  to COFB/COFT") : la demande est bien comprise, mais la destination
  physique ("CollectionUnit") n'existe probablement pas dans l'état actuel de
  l'émulateur. **Piste identifiée, non testée** : le manuel
  `RBW100_SimulatorManual.pdf` (p.15-18) décrit une **"Collection Door
  Operation"** et une **"Change Cassette Operation"** dans la fenêtre
  "Operation" de l'émulateur (bouton "Door Set" pour ouvrir la porte de
  collecte, "IF Cst"/"Stack Cst" pour définir le type de cassette) — jamais
  utilisées jusqu'ici (seul le dialogue "Entrance" pour les billets a été
  exploré). **Suite le 2026-07-29** : piste creusée jusqu'au bout —
  1. `UnlockUnit(type=1)` appelé via SOAP pour libérer le verrou électronique
     (le manuel RBW100 précise : "The electronic lock cannot be operated from
     this simulator. Please request to operate from CI-10.") → `result=0`.
  2. "Door Set" cliqué dans l'émulateur (ouvre la porte de collecte) →
     `GetStatus` a montré `DevStatus[devid=1].st` passer à `9100` (nouveau
     code non documenté, probablement "porte ouverte").
  3. "Stack Cst" cliqué (insère une cassette de collecte).
  4. "Door Set" re-cliqué pour refermer → `st` repasse à `1000`.
  5. `Collect` retenté → **`result` change de `11` à `12`** ("dispensed
     change inconsistency") — la précondition de cassette est donc bien la
     bonne piste, la requête progresse réellement.
  6. Mais ensuite, `Inventory` et `Collect` restent bloqués à `result=11`,
     **même après un `Reset` explicite ET un redémarrage complet du service
     FCC** (`systemctl restart fccx.service`) — chose jamais observée
     jusqu'ici (tous les blocages précédents cédaient à un simple `Reset`).
     Le log FCC (`GLOG_BrueBoxService.log`) confirme : ce `Reset` a mis
     **24 secondes** en interne à répondre, contre quasi-instantané pour tous
     les `Reset` précédents — signe d'un mécanisme physique (la cassette
     nouvellement insérée) réellement coincé côté émulateur, pas juste un
     verrou logiciel.
  **Suite et conclusion finale (2026-07-29, après `vmrun reset ... soft`)** :
  un redémarrage complet de la VM a bien nettoyé l'état incohérent
  (`Inventory` repasse à `result=0` juste après le boot, config
  `SoapUserCheck`/`OccupyEnable` conservée — ce sont des fichiers sur disque,
  pas des réglages en mémoire). **Mais `Collect` retenté immédiatement après
  redonne exactement `result=12` ("dispensed change inconsistency"), de façon
  stable et reproductible** — ce n'est donc plus un état corrompu mais un
  **résultat métier cohérent et répétable** : la cassette de collecte
  "Stack Cst" configurée dans l'émulateur ne peut probablement pas
  correctement simuler la réception physique de billets déjà comptés ailleurs
  (limite de fidélité assumée par le constructeur —
  `RBW100_SimulatorManual.pdf` p.4 : *"RBW-100 simulator does not emulate the
  actual machine completely."*). Par ailleurs, chaque tentative `Collect`
  laisse de nouveau `Inventory` bloqué à `result=11` jusqu'au prochain
  redémarrage VM (un simple `Reset` ne suffit plus une fois que ce cas s'est
  produit) — comportement reproduit deux fois à l'identique.
  **Verdict** : le code (`core/soap-client`, méthode `collect`) est validé —
  requête correctement formée, comprise par le FCC, résultat métier cohérent
  et stable obtenu (12, pas une erreur de parsing/format). **La validation
  d'un `Collect` réussi (`result=0`) n'a pas pu être obtenue sur cet
  émulateur** — probablement une limite de fidélité de simulation plutôt
  qu'un bug côté client ou VM.
  **Contre-test le 2026-07-29** : l'hypothèse "cassette I/F au lieu de Stack"
  (confirmée efficace pour `StartReplenishmentFromCassette`, voir l'entrée
  suivante) a été spécifiquement retestée sur `Collect` avec exactement la
  même cassette I/F déjà en place — **résultat strictement identique
  (`result=12`)**. Le type de cassette de collecte n'est donc **pas** la
  variable en cause pour `Collect` (contrairement à
  `StartReplenishmentFromCassette`, où c'était bien le problème) — confirme
  qu'il s'agit d'une limite de fidélité de simulation générale plutôt que
  d'un paramétrage réparable. À re-tester uniquement sur matériel réel, ou
  avec une valeur `Piece` différente (non exploré).
  **Bloquant : non** pour la suite du développement — le code est correct et
  testé ; **note opérationnelle** : après tout `Collect`, prévoir un
  redémarrage VM si `Inventory` reste bloqué à `11`.

- [x] **`StartReplenishmentFromCassette`/`EndReplenishmentFromCassette`
  validés le 2026-07-29** — confirmation de l'hypothèse "IF Cst au lieu de
  Stack Cst" (contrairement à `Collect` ci-dessus, où ce même changement de
  cassette n'a rien changé — la précondition "cassette I/F" est donc
  spécifique à `StartReplenishmentFromCassette`, documentée telle quelle par
  l'IF Spec p.140, pas une règle générale du simulateur). Procédure : `UnlockUnit`
  (SOAP) → "Door Set" (émulateur) → **"IF Cst"** (pas "Stack Cst") →
  "Door Set" pour refermer. `StartReplenishmentFromCassette(type=0 "Both")` →
  `result=0` (succès — confirme la précondition "cassette I/F" de l'IF Spec
  p.140). `EndReplenishmentFromCassette` → `result=33` ("IF cassette illegal
  denomination"), cohérent : la cassette I/F insérée était vide (aucun billet
  préchargé via le "Money Handling Dialog" de l'émulateur, jamais utilisé —
  distinct du dialogue "Entrance"). `ResultDetail` confirme le traitement par
  RBW (`devid=1`) et RCW (`devid=2`).
  **Bloquant : non** — le code est validé au niveau protocole (requête bien
  formée, précondition correctement identifiée, résultat métier cohérent).
  Pour un `result=0` complet, il faudrait précharger la cassette I/F via le
  "Money Handling Dialog" (non tenté, section 3-3 des manuels simulateur) —
  non exploré faute de temps, non bloquant pour la suite.

- [x] ~~**Scénario "billet catégorie 2/3" (Sequence Spec §3.19)**~~ **Retesté
  le 2026-07-29 en suivant strictement l'ordre documenté (sans `EndCashin`) —
  conclusion (b) confirmée : c'est une limite de fidélité du simulateur
  RBW-100, pas un problème côté client/`EndCashin`.**

  Table de référence trouvée pendant l'investigation (IF Spec p.39/254,
  "Device status" — corrige les hypothèses précédentes) :
  `DevStatus.st` : `1000`=STATE_IDLE, `1500`=STATE_IDLE_OCCUPY,
  `2000`=STATE_DEPOSIT_BUSY, `2050`=STATE_DEPOSIT_COUNTING (pas "billet
  bloqué à la sortie" comme précédemment supposé), `5000`=STATE_RESET,
  `9100`=STATE_BUSY (pas "porte ouverte" comme précédemment supposé),
  `9200`=STATE_ERROR, `9300`=STATE_COM_ERROR, `9400`=STATE_WAIT_FOR_RESET.
  Et `Status.Code` (IF Spec p.180/254, §3.51 StatusChangeNotification) :
  `3`=Waiting insertion of cash, `6`=Waiting removal of cash in reject,
  `8`=Resetting, `13`=Error, `24`=Counted category2 note, `30`=Waiting for
  Error recovery.

  **Retest propre (sans `EndCashin`)** : `StartCashin` → insertion `Cat=2` →
  `GetStatus` se stabilise à `Status.Code=6` ("Waiting removal of cash in
  reject"), `DevStatus[RBW].st=2050` (STATE_DEPOSIT_COUNTING) — état stable
  et reproductible, confirmé stable sur >1 min de polling sans évoluer vers
  `Code=13`/`30`. **`OpenExitCoverOperation` appelé directement à cet état
  (aucun `EndCashin` entre les deux) → `result=11` (exclusive error),
  réponse rapide (~100ms), pas de hang.** Retenté plusieurs fois après
  attente, même résultat stable.
  **Test complémentaire** : `CashinCancelOperation` (IF Spec §3.6, "Cancel
  Cash in Request" — distincte d'`EndCashin`, documentée valide uniquement
  "in the middle of cash-in transaction") tentée à ce même état →
  **bloquée indéfiniment (timeout 30s), exactement comme `EndCashin` lors du
  premier essai.**
  **Conclusion définitive** : le blocage n'est **pas spécifique à
  `EndCashin`** — toute opération qui tente de clore/annuler la transaction
  de cash-in pendant un état "billet cat.2/3 détecté" fait planter le
  simulateur RBW-100 indéfiniment. `OpenExitCoverOperation` seul (sans
  clôture) ne bloque jamais, mais ne réussit pas non plus (`result=11`
  systématique). C'est cohérent avec le disclaimer déjà documenté pour
  `Collect` : "RBW-100 simulator does not emulate the actual machine
  completely" — limite de fidélité du simulateur, pas un bug du client.
  **Découverte clé sur la récupération** : après un blocage, un redémarrage
  VM seul ne suffit **pas** à nettoyer l'état — l'émulateur RBWXSim.exe
  tourne comme process **hôte** (Windows), séparé de la VM, et garde le
  billet coincé en mémoire même après reboot VM. La récupération fiable est :
  (1) `systemctl restart fccx.service` sur la VM (SSH), **puis** (2) tuer et
  relancer le process `RBWXSim.exe` sur l'hôte. Cette combinaison a suffi à
  retrouver un état propre (`st=1000` sur les deux devices) sans nécessiter
  de reboot VM complet lors du deuxième blocage.
  **Bloquant : non** pour le développement général — `OpenExitCover`/
  `CloseExitCover` restent validés en usage normal (voir plus haut) ;
  seul le succès complet du scénario d'erreur cat.2/3 (`OpenExitCover`
  réussissant réellement) n'a pas pu être obtenu sur ce simulateur. **Règle
  de sécurité à retenir pour le code client** : ne jamais appeler
  `EndCashin` NI `CashinCancel` si `GetStatus` révèle un état d'erreur
  inhabituel (`Status.Code` ∈ {6, 13, 24, 30}) — appeler `OpenExitCover`
  directement, et si celui-ci échoue aussi, ne pas insister avec d'autres
  opérations de clôture : escalader vers une intervention manuelle
  (redémarrage service/émulateur) plutôt que de risquer un blocage matériel.

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
