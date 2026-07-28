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

## Points à vérifier avant le matériel réel

Voir la section dédiée dans **[open-questions.md](open-questions.md)**
("Points à vérifier en interne (sur simulateur ou plus tard sur matériel
réel)") — non dupliquée ici.
