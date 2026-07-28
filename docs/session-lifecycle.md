# Cycle de vie d'une session caisse↔FCC

Source principale : `Sequence Spec §3.1 "General Command Execution" (p.9)` et
`§3.2 "Initial Process" (p.10)`, complétées par `IF Spec p.114-121` pour la
sémantique exacte d'Open/Occupy/Release.

## Enveloppe générique de session (Sequence Spec §3.1, p.9)

```
Caisse (Pos)                              FCC
    │──── Open Request (UserID) ─────────▶│   *
    │◀─── Open Response (SessionID) ──────│
    │──── Occupy Request (SessionID) ────▶│   *
    │◀─── Occupy Response (SessionID) ────│
    │──── [Any Request] (SessionID) ─────▶│  ┐
    │◀─── [Any Response] (SessionID) ─────│  ├─ boucle transactions du jour
    │             ...                     │  ┘
    │──── Release Request (SessionID) ───▶│   *
    │◀─── Release Response (SessionID) ───│
    │──── Close (SessionID) ─────────────▶│   *
    │◀─── Close Response (SessionID) ─────│
```

`*` = Open/Occupy/Release/Close sont **ignorables** si les modes serveur
"Session mode" et "Occupy mode" sont désactivés côté FCC (`Sequence Spec §3.1`,
note associée au diagramme). En configuration standard, ils sont utilisés.

## SessionID

- Retourné par `OpenResponse` (`WSDL BrueBoxService.wsdl`, complexType
  `OpenResponseType`).
- Sert d'identifiant de corrélation pour toutes les opérations suivantes
  (`SessionID` présent comme paramètre optionnel dans la quasi-totalité des
  complexTypes `*RequestType` du WSDL).
- **Ce n'est pas un secret cryptographique** : `IF Spec` ne documente aucune
  vérification d'intégrité/signature du SessionID — il s'agit d'un identifiant de
  session, pas d'un jeton d'authentification (voir `development-notes.md` pour
  l'implication sécurité).
- Codes retour liés à Open : `15` échec d'authentification utilisateur, `16` trop
  de sessions simultanées, `20` session non disponible (`IF Spec p.238-239`,
  Result Code Matrix — voir `error-codes.md`).

## Occupy Mode

- Opérations : `OccupyOperation` / `ReleaseOperation` (`WSDL BrueBoxService.wsdl`
  lignes 2859, 2864).
- Sémantique : « After occupation, other users can't use CI-10 until this user is
  released. » (`IF Spec p.118-121`).
- C'est un **verrou exclusif de disponibilité**, lié à la session (pas au
  `TillID`), posé **une seule fois après Open**, pas répété par transaction
  (`Sequence Spec §3.1`).
- Option `OccupyImg` (0-3) : affiche une animation "occupé" sur l'écran client de
  la machine (`IF Spec`, détail sur `OccupyRequest`).
- État machine associé : `STATE_IDLE_OCCUPY` (`1500`) (`IF Spec p.39`).
- Codes retour : `0` succès, `3` occupé par un autre, `4` occupation indisponible,
  `17` déjà occupé par soi-même (ré-occupation par le même titulaire), `21` session
  invalide, `22` timeout de session.
- **Durée du timeout non documentée** dans les sections de l'IF Spec lues à ce
  jour — le code retour `22` existe mais sa valeur numérique de délai n'a pas été
  trouvée. **[à vérifier — voir open-questions.md]**

## RegisterEvent

- Opération : `RegisterEventOperation` (`WSDL BrueBoxService.wsdl` ligne 2933,
  complexType `RegisterEventRequestType` lignes 800-813).
- Paramètres (`WSDL`) : `Id`, `SeqNo`, `SessionID` (optionnel), `Url` (obligatoire),
  `Port` (optionnel), `DestinationType` (0=POS/Other, 1=Server — réservé
  CI-Server, active la reprise hors-ligne, `IF Spec p.90`), `Encryption`
  (0=aucun, 1=SSL, s'applique au canal événement uniquement), `RequireEventList`,
  `TillID`.
- Jusqu'à **4 destinations simultanées** peuvent être enregistrées (`IF Spec
  p.90`, ligne ~4429 de l'extraction texte).
- C'est le couple `Url`/`Port` fourni qui détermine le transport réellement
  utilisé côté événement (URL type SOAP → callback SOAP ; IP:port → socket TCP
  brut) — voir `event-system.md` pour le détail complet.
- Étape 1 du "Initial Process" (voir plus bas) : l'enregistrement se fait au
  tout début de la session, avant même la synchronisation d'heure.

## Release

- Opération : `ReleaseOperation` — libère le verrou Occupy.
- Doit être appelée avant `Close` en fin de session (`Sequence Spec §3.1`).
- Sans `Release` explicite, la machine reste indisponible pour tout autre client
  tant que la session n'expire pas (durée de timeout non documentée, voir
  ci-dessus).

## Processus initial (démarrage caisse) — Sequence Spec §3.2, p.10

Séquence en 4 étapes documentées :

1. **Enregistrement événements** : la caisse s'enregistre comme destinataire
   (`RegisterEvent`).
2. **Synchronisation d'heure** : si le FCC en a besoin, l'heure est ajustée à
   partir de l'heure de la caisse.
3. **Lecture du statut** : `Status` — état du FCC, des dispositifs, et du flag
   de vérification requise.
4. **Branchement selon l'état** :
   - `4.1` **idle** → obtenir l'inventaire (`Inventory`) ;
   - `4.2` **error** → vérifier la connectivité des dispositifs, exécuter
     `Reset` ;
   - `4.3` **initializing** → corriger la configuration, vider les cassettes,
     redémarrer le FCC ;
   - `4.4` **require-verification** → exécuter le processus verify-collect
     (`Collect` avec `RequireVerification=1`, voir `Sequence Spec §3.18`).

## Erreurs possibles au niveau session

| Code | Signification | Contexte |
|---|---|---|
| 15 | user authentication failure | `Open`, si "User check" activé côté serveur |
| 16 | number of session over | `Open`, trop de sessions concurrentes |
| 20 | session not available | `Open` |
| 21 | invalid session | toute opération utilisant un `SessionID` expiré/invalide |
| 22 | session timeout | toute opération, durée non documentée |
| 3 | occupied by other | `Occupy`, machine déjà verrouillée par un autre client |
| 4 | occupation not available | `Occupy` |
| 17 | occupied by itself | `Occupy`, ré-occupation par le titulaire actuel |

(Source : `IF Spec p.238-239`, Result Code Matrix — voir `error-codes.md` pour la
table complète et son statut d'extraction.)

## Diagramme de séquence complet (transaction type)

Reconstruction combinant `Sequence Spec §3.1/§3.2` (structure de session) et les
opérations métier détaillées dans `soap-operations.md` :

```
Caisse                          FCC (SOAP)              Canal événement (SOAP cb ou TCP)
  │──── Open(UserID) ──────────▶│
  │◀─── SessionID ───────────────│
  │──── RegisterEvent(Url,Port, │
  │      DestinationType) ─────▶│
  │◀─── ack ──────────────────────│
  │──── Occupy(SessionID) ─────▶│
  │◀─── OK(0) / occupé(3) ───────│
  │──── Status / Inventory ────▶│
  │◀─── état courant ─────────────│
  │──── StartCashin ───────────▶│
  │◀─── ack ───────────────────────│
  │                              │──── Event: billet détecté ─────────▶│ (async)
  │──── EndCashin ──────────────▶│
  │◀─── résultat + TransactionId (livré via événement, pas la réponse SOAP
  │      synchrone, en mode par défaut — IF Spec, annotation récurrente) │
  │──── Change(montant) ───────▶│
  │◀─── résultat distribution ──│
  │                              │──── Event: distribution terminée ───▶│
  │──── Release(SessionID) ────▶│
  │◀─── OK ────────────────────────│
  │──── Close(SessionID) ───────▶│
  │◀─── OK ────────────────────────│
```

Pour les séquences métier détaillées par scénario (Pre Cash In, Change, Cash Out,
Replenishment, Collect, Cassette Removal, Reboot...), voir les sections
correspondantes de `Sequence Spec §3.4` à `§3.21` — résumées par opération dans
`soap-operations.md` et par code d'erreur dans `error-codes.md`.
