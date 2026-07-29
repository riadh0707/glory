# Système d'événements

## Pourquoi deux mécanismes existent

Le FCC pousse des notifications asynchrones (billet détecté, distribution
terminée, erreur, etc.) vers la caisse via **deux canaux officiellement
supportés simultanément**, et non un canal unique ou une divergence
documentation/code :

> « FCC implements event notification also. And that event notification covers
> TCP and SOAP interface. Application can register the event destination by
> using one of following SOAP interface. »
> — `Sequence Spec §2.1 (p.6)`

Le diagramme associé (`Sequence Spec §2.1`) montre le FCC exposant à la fois un
**serveur SOAP** et un **serveur Node.js / port TCP**, tous deux capables
d'émettre "Response" et "Event Notice".

Cette conception à deux canaux explique une observation antérieure qui semblait
être une contradiction : le WSDL client `EventService.wsdl` définit un callback
SOAP (`BbxEventOperation`), tandis que le code d'exemple `PosSimple` utilise un
socket TCP brut. **Ce n'est pas une incohérence** — ce sont deux mécanismes
alternatifs prévus par le constructeur, sélectionnés au moment de
l'enregistrement.

## Callback SOAP

- Défini par `WSDL EventService.wsdl` : service `EventService`, port
  `BrueBoxPort`, opération `BbxEventOperation`.
- Requête : `BbxEventRequestType` — corps générique `<xsd:any/>` (le contenu
  exact dépend de l'événement).
- Réponse : `BbxEventResponseType` — attribut `result:xsd:int`.
- Le `soap:address` documenté dans le WSDL
  (`http://service.bruebox.com:9090/axis2/services/BrueBoxService`) est un
  **placeholder** — la cible réelle est l'`Url`/`Port` fournis par la caisse à
  `RegisterEvent` [déduction à partir de la structure du WSDL, cohérente avec le
  mécanisme décrit dans `IF Spec p.90`, mais l'IF Spec ne le formule pas
  littéralement ainsi — **marqué comme interprétation, pas citation directe**].
- Éléments d'enveloppe `Date`, `SeqNo`, `Offline` : explicitement annotés
  **« This element is set only if the destination is SOAP type »**
  (`IF Spec p.24-25`) — l'enveloppe SOAP est donc plus riche que l'enveloppe TCP.

## Socket TCP brut

- Non défini par un schéma WSDL/XSD publié.
- Observé dans le code d'exemple `App/PosSimple` : port ~55561/55562, trames
  terminées par NUL [observation du code d'exemple, pas de l'IF Spec —
  **le format exact de trame n'est pas documenté dans l'IF Spec lui-même**,
  seulement déduit du code client].
- Charge utile plus légère que la variante SOAP (absence de `Date`/`SeqNo`/
  `Offline`, `IF Spec p.24-25`).

## Différences résumées

| Aspect | Callback SOAP | Socket TCP brut |
|---|---|---|
| Schéma publié | Oui (`EventService.wsdl`) | Non |
| Enveloppe | Riche (`Date`, `SeqNo`, `Offline` inclus) | Légère (ces éléments absents, `IF Spec p.24-25`) |
| Portabilité d'implémentation | Élevée (toute pile SOAP peut exposer le endpoint) | Élevée aussi (socket TCP trivial dans tout langage), mais format de trame non standardisé par le constructeur |
| Chiffrement | Option `Encryption=1 (SSL)` sur `RegisterEvent`, applicable aux deux canaux | idem |
| Utilisé par les exemples fournis | `EventService.wsdl` défini mais pas illustré par du code d'exemple lu | `App/PosSimple` (constaté) |

## Fonctionnement de l'enregistrement (`RegisterEvent`)

- Opération : `RegisterEventOperation` (`WSDL BrueBoxService.wsdl`).
- Paramètres clés : `Url` (obligatoire), `Port` (optionnel), `DestinationType`
  (0=POS/Other, 1=Server — réservé CI-Server, active la reprise hors-ligne),
  `Encryption` (0/1), `RequireEventList`, `TillID` (`IF Spec p.90-91`).
- **C'est le couple `Url`/`Port` qui détermine le transport réel** — pas
  `DestinationType`, qui sert à distinguer un client standard (POS/Other) d'un
  serveur central CI-Server avec logique de reprise hors-ligne.
- Jusqu'à **4 destinations simultanées** (`IF Spec p.90`).
- Symétrique : `UnRegisterEventOperation` (params `Url`, `Port`), et
  `EventNotificationStatusOperation` pour interroger l'état d'enregistrement.

## Table des événements (extraite de `IF Spec §10 "Event number table", p.242-243`)

97 événements numérotés (0 à 96) sont catalogués. Extrait représentatif (liste
complète disponible dans l'IF Spec aux pages citées) :

| N° | Nom événement |
|---|---|
| 0 | RegisterEvent |
| 1 | UnRegisterEvent |
| 2 | StatusResponse |
| 3 | ChangeResponse |
| 5 | StartCashinResponse |
| 6 | EndCashinResponse |
| 40 | HeartBeatEvent |
| 41 | StatusChangeEvent |
| 56 | eventError |
| 60 | IncompleteTransaction |
| 66 | eventRequireVerifyDenomination |
| 68 | eventRequireVerifyCategoryNote |
| 75 | ChangeInventoryStatus |
| 77 | SpecialDeviceError |
| 88 | eventCountedCategory2 |
| 89 | eventCountedCategory3 |
| 96 | GetSettingFileResponse |

Catégories observables dans la table complète : (a) copies-événements des
réponses de commandes (ex. `ChangeResponse`, `StartCashinResponse` — permettent
de recevoir le résultat d'une opération de façon asynchrone, notamment le
`TransactionId` — voir `session-lifecycle.md`), (b) événements dispositif purs
(`eventEmpty`, `eventLow`, `eventFull`, `eventMissing`, `eventOpened`,
`eventClosed`, `eventLocked`...), (c) événements de vérification/catégorie note
(`eventRequireVerify*`, `eventCounted*`), (d) `HeartBeatEvent` pour la
supervision de connexion.

**Note d'extraction** : cette table provient d'un tableau PDF converti en texte
brut (`pdftotext -layout`) ; la numérotation et les noms ont été vérifiés
cohérents sur toute la plage 0-96, mais une éventuelle colonne de description
associée (si elle existe dans le PDF original) n'a pas été extraite — seuls
noms et numéros sont confirmés.

## Confirmation empirique (2026-07-29) — le canal TCP échoue quasi toute réponse SOAP

En testant l'application Electron réelle (pas un script isolé) avec le canal
TCP enregistré via `RegisterEvent`, **chaque appel SOAP effectué pendant la
session a produit une trame TCP correspondante**, pas seulement les 97
événements numérotés du tableau ci-dessus. Observé sur une seule session :
copies de `StatusResponse`, `InventoryResponse`, `RomVersionResponse`,
`GetSettingFileResponse`, `EnableDenomResponse`, `ReleaseResponse`,
`CloseResponse` — en plus d'un `GlyCashierEvent`/`eventLogreadProgress` non
sollicité (probablement une activité de fond du FCC, sans lien avec l'appel en
cours) et d'un `HeartBeatEvent` périodique.

**Structure de trame confirmée** (canal TCP brut, UTF-8, terminée par `\0`) :

```
<BbxEventRequest><StatusResponse result="0">
  <Id />
  <SeqNo>4</SeqNo>
  <User>posadmin</User>
  <Status>
    <Code>0</Code>
    <DevStatus devid="1" val="0" st="1000" />
    <DevStatus devid="2" val="0" st="9100" />
  </Status>
</StatusResponse></BbxEventRequest>\0
```

Chaque trame reprend le nom exact de la réponse SOAP correspondante
(`<XxxResponse result="N">...`), avec la même structure interne que la réponse
SOAP synchrone elle-même — **enveloppée** dans `<BbxEventRequest>...
</BbxEventRequest>`. C'est cohérent avec la catégorie (a) déjà identifiée
("copies-événements des réponses de commandes"), mais c'était jusqu'ici une
déduction à partir du tableau de noms d'événements (`IF Spec §10`), jamais
confirmée avec une trame réelle capturée — **c'est fait ici**.

`HeartBeatEvent` observé :

```
<BbxEventRequest><HeartBeatEvent>
  <SerialNo>0123456789</SerialNo>
</HeartBeatEvent></BbxEventRequest>\0
```

**Implication pratique pour le client** : le canal TCP peut servir de **flux
de confirmation redondant** pour toute opération SOAP synchrone (utile si la
réponse HTTP se perd ou si l'UI veut afficher un journal d'activité complet
sans dépendre uniquement des réponses synchrones) — mais le code actuel
(`core/event-listener`) ne fait qu'un affichage brut (UTF-8 + hex), sans
parser cette structure. Parser cet enveloppe `BbxEventRequest` reste à faire
si un usage applicatif du canal TCP est requis au-delà du logging diagnostic.

## Format des messages

- **Non totalement documenté** pour le canal TCP brut dans l'IF Spec lui-même
  (uniquement observable via le code d'exemple `PosSimple`, non repris ici en
  détail — voir le code source directement si nécessaire).
- Pour le canal SOAP, le corps est un `<xsd:any/>` — la structure précise par
  type d'événement n'a pas été extraite exhaustivement dans cette passe.
  **[à approfondir avant implémentation du parsing d'événements]**

## Ports

- Port du serveur SOAP du FCC : non énoncé dans l'IF Spec elle-même. Le WSDL
  documente `9090`/HTTP à titre d'exemple, mais **vérifié empiriquement le
  2026-07-28 sur la VM simulateur (firmware 18.30R1) : le service réel tourne
  en HTTPS sur le port 443** (Axis2C) — voir `architecture.md`. Ne pas coder le
  port en dur ; le rendre configurable, la valeur réelle pouvant différer par
  environnement/firmware.
- Port du canal événement (SOAP ou TCP) : **choisi par la caisse**, transmis au
  FCC via `RegisterEvent` (`IF Spec` : « Sets TCP port number to be
  registered ») — ce n'est pas un port fixe côté FCC.

## Choix recommandé pour le développement du client

Recommandation d'ingénierie (pas une prescription du SDK) : implémenter les
**deux mécanismes** derrière une interface commune (voir `development-notes.md`,
section architecture), car :
1. le canal SOAP est auto-documenté (WSDL) et donc plus simple à valider/typer ;
2. le canal TCP est plus léger et déjà éprouvé par le code d'exemple fourni
   (`PosSimple`) ;
3. rien dans la documentation n'indique qu'un des deux canaux sera déprécié ou
   qu'un des modèles (CI-05/10/10X/50) impose l'un plutôt que l'autre — les
   deux sont documentés au niveau protocole générique (`Sequence Spec §2.1`).
