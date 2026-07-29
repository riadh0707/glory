# Référence des opérations SOAP — BrueBoxService

Liste canonique extraite directement de `WSDL BrueBoxService.wsdl`
(`wsdl:portType name="BrueBoxPortType"`, lignes 2859-3123) — **53 opérations
uniques**. C'est la source de vérité pour les noms exacts ; le WSDL est aussi
dupliqué dans le binding SOAP (lignes 3130-3660, identique).

Légende colonne **Détail** :
- ✅ **Complet** = paramètres request/response + codes résultat confirmés
  (WSDL + IF Spec)
- 🟡 **Partiel** = nom, paramètres WSDL de base connus, mais sémantique/codes
  résultat détaillés non extraits de l'IF Spec dans cette passe
- ⬜ **Non extrait** = seul le nom (WSDL) est confirmé ; ni les paramètres
  détaillés ni la sémantique n'ont été vérifiés dans l'IF Spec — **ne pas
  deviner, rouvrir `IF Spec` avant implémentation**

## Table complète

| Opération (WSDL) | Objectif | Détail | Dépendances | Remarques |
|---|---|---|---|---|
| `OpenOperation` | Ouvre une session, obtient un `SessionID` | ✅ | Aucune (premier appel) | `UserPwd` non vérifié sauf option "User check" activée (`IF Spec p.114`) |
| `CloseOperation` | Ferme la session | ✅ | Session ouverte ; `Release` doit précéder si Occupy actif | — |
| `OccupyOperation` | Verrouille la machine en exclusivité | ✅ | Session ouverte | Voir `session-lifecycle.md` |
| `ReleaseOperation` | Libère le verrou Occupy | ✅ | Occupy actif | — |
| `GetStatus` | État courant temps réel (machine, dispositifs, flag vérif requise) | ✅ | Session | Ne pas appeler en polling continu (`IF Spec p.36`) |
| `ChangeOperation` | Encaissement + rendu de monnaie | ✅ | Occupy | Codes: 6,9,10,12,13,40,41,43,44,96,99,100 — voir `error-codes.md` |
| `ChangeCancelOperation` | Annule une opération Change en cours | ✅ | Change en cours | — |
| `StartCashinOperation` | Démarre un cycle d'encaissement | ✅ | Occupy | Suivi de `EndCashin` ou `CashinCancel` |
| `EndCashinOperation` | Termine un cycle d'encaissement | ✅ | `StartCashin` en cours | `TransactionId` livré par événement, pas systématiquement dans la réponse synchrone. **Le montant réellement compté est dans `Cash.Denomination`, PAS dans `ManualDeposit`** (qui reste à 0 même avec un vrai dépôt — c'est un champ distinct pour la saisie manuelle via `UpdateManualDepositTotal`) — vérifié empiriquement le 2026-07-28 sur simulateur avec un billet réellement inséré |
| `CashinCancelOperation` | Annule un cycle d'encaissement en cours | ✅ | `StartCashin` en cours | **Piège empirique (2026-07-29, simulateur)** : appelé alors qu'un billet catégorie 2/3 venait d'être détecté (`Status.Code=6`), l'appel est resté bloqué indéfiniment (>30s, jamais de réponse) — même symptôme qu'`EndCashin` dans le même scénario. Voir `open-questions.md` et la règle de sécurité dans `development-notes.md` : ne pas appeler d'opération de clôture/annulation de cash-in quand `GetStatus` indique une anomalie, préférer `OpenExitCover` |
| `CashoutOperation` | Distribution seule (sans encaissement préalable) | ✅ | Occupy | Mêmes codes de distribution que Change |
| `InventoryOperation` | État des stocks par dénomination | ✅ | Session | Appelé en routine au démarrage (`Sequence Spec §3.2`) |
| `ResetOperation` | Reset dispositif, annule un cash-in en cours | ✅ | Session | Utilisé en "Error Recovery" (`Sequence Spec §3.3`) |
| `CollectOperation` | Vidage cassette (total/partiel/mix/IFCassette) | ✅ | Occupy | Codes: 12,35,40,100 ; option `RequireVerification=1` = verify-collect (`Sequence Spec §3.18`) |
| `CounterClearOperation` | Remise à zéro de compteur | ✅ (params) / 🟡 (usage) | Session | **Marquée "*** Do not use this Method ***" dans l'IF Spec (p.88) — dépréciée, à éviter** |
| `RegisterEventOperation` | Enregistre une destination d'événements | ✅ | Session | Voir `event-system.md` — jusqu'à 4 destinations |
| `UnRegisterEventOperation` | Désenregistre une destination d'événements | ✅ | `RegisterEvent` préalable | Params: `Url`, `Port` (WSDL lignes 828-836) |
| `EventNotificationStatusOperation` | Interroge le statut d'enregistrement événement | ✅ | Session | Retourne `Status` (type `EventNotificationStatusType`) |
| `LoginUserOperation` | Enregistre un identifiant utilisateur | ✅ | Aucune | **« There is no authentication function »** (`IF Spec p.97`) — pas de vérification de mot de passe. Testé réel le 2026-07-29 : `result=0` |
| `LogoutUserOperation` | Déconnecte l'utilisateur | ✅ | `LoginUser` préalable | Params: `Id`, `SeqNo` uniquement (WSDL lignes 896-901). Testé réel le 2026-07-29 : `result=0` |
| `RomVersionOperation` | Version firmware/matériel par sous-module | ✅ | Session | Sous-modules: RBW10/50/100/150/200, RCW8X/50/100/200, RZ50/100, RBG200, RBW100HVE200 (WSDL lignes 935-947). Testé réel le 2026-07-29 sur la VM (RBW100+RCW100 seulement présents, `CUTE="ISP-K05B Ver.18.30R1"`, `KERNEL="5.4.0-113-generic"`) : `result=0` |
| `StartDownloadOperation` | Démarre le téléversement d'un paquet de config (langue/devise) | 🟡 | Session | Utilisé par `PackageCreator` pour déployer les `.tar.gz` — confirme un FCC sous OS Linux embarqué |
| `StartLogreadOperation` | Démarre la lecture de logs techniques dispositif | ✅ (existence) / 🟡 (format) | Session | Logs techniques, **pas** un historique de transactions métier |
| `UpdateManualDepositTotalOperation` | Met à jour un total de dépôt manuel | 🟡 | Session | Nom WSDL confirmé, sémantique détaillée non extraite |
| `RefreshSalesTotalOperation` | Rafraîchit le total des ventes | 🟡 | Session | Nom WSDL confirmé, sémantique détaillée non extraite |
| `ReturnCashOperation` | Renvoi d'objet étranger / espèces | ✅ (cas connu) | Session | Utilisé pour "Return Coin" (objet étranger entrée pièces), `Option=2` (`Sequence Spec §3.20`) |
| `EnableDenomOperation` | Ré-autorise une dénomination interdite (ex. après pénurie de monnaie) | ✅ | Session (Occupy requis) | `IF Spec p.128-130` §3.27 "Permit Denomination Request". `Cash type="5"`, `Piece`/`Status` fixés à `0` dans l'exemple. Testé réel le 2026-07-29 (EUR 20€ devid=1) : `result=0` |
| `DisableDenomOperation` | Interdit temporairement une dénomination | ✅ | Session (Occupy requis) | Symétrique de `EnableDenom`, `IF Spec p.130-132` §3.28. Testé réel le 2026-07-29 (EUR 20€ devid=1) : `result=0` |
| `PowerControlOperation` | Contrôle d'alimentation (reboot/arrêt) | 🟡 | Session | Correspond à "Power control, Option=1" pour Reboot (`Sequence Spec §3.21`, p.57) ; si CI-Server actif, synchronise les utilisateurs au redémarrage |
| `AdjustTimeOperation` | Ajuste l'heure du FCC | ✅ | Session (Occupy requis — codes `3`/`5` "occupied by other"/"not occupied") | Utilisé à l'étape 2 du "Initial Process" (`Sequence Spec §3.2`). Params confirmés `IF Spec p.135` : `Date` (attrs `month`/`day`/`year`), `Time` (attrs `hour`/`minute`/`second`). Testé réel le 2026-07-29 (aligné sur l'heure système) : `result=0` |
| `StartReplenishmentFromEntranceOperation` | Démarre un réapprovisionnement par l'entrée | ✅ | Occupy | `Sequence Spec §3.11` ; erreur = Result 40 (cassette invalide) |
| `EndReplenishmentFromEntranceOperation` | Termine un réapprovisionnement par l'entrée | ✅ | `StartReplenishmentFromEntrance` en cours | — |
| `ReplenishmentFromEntranceCancelOperation` | Annule un réapprovisionnement par l'entrée | ✅ (existence) | en cours | — |
| `StartReplenishmentFromCassetteOperation` | Démarre un réapprovisionnement par cassette | ✅ | Occupy | `Sequence Spec §3.13` ; Result 32 (vérif requise), 33 (dénomination erronée / stacker plein). **Précondition critique confirmée (IF Spec p.140) : nécessite une cassette de type I/F (Interface), pas "Stack"** — testé réel le 2026-07-29, `result=0` avec cassette I/F insérée |
| `EndReplenishmentFromCassetteOperation` | Termine un réapprovisionnement par cassette | ✅ | `StartReplenishmentFromCassette` en cours | Testé réel le 2026-07-29 : `result=33` ("IF cassette illegal denomination") avec une cassette I/F vide (aucun billet préchargé) — comportement métier cohérent, pas une erreur de code. `ResultDetail` confirme le traitement par les deux dispositifs (RBW/RCW) |
| `LockUnitOperation` | Verrouille physiquement une unité/cassette | ✅ (usage) / 🟡 (params) | Session | `Sequence Spec §3.15` : Lock pour annuler un retrait de cassette |
| `UnLockUnitOperation` | Déverrouille physiquement une unité/cassette | ✅ (usage) / 🟡 (params) | Session | Visible uniquement sur CI-10/CI-50 selon `Manual.txt` (doc tierce, non confirmé indépendamment pour CI-05/CI-10X — voir `models.md`) |
| `OpenExitCoverOperation` | Ouvre le couvercle de sortie | ✅ | Session | Utilisé pour retirer des billets catégorie 2/3 détectés (`Sequence Spec §3.19`). Testé réel le 2026-07-29 en usage normal : `result=0`. **Mais dans le scénario d'erreur billet cat.2/3 lui-même** (`Status.Code=6`), retesté le 2026-07-29 : `result=11` systématique (pas de hang, réponse rapide ~100ms), jamais de succès obtenu sur ce simulateur — limite de fidélité probable (comme `Collect`), voir `open-questions.md` |
| `CloseExitCoverOperation` | Ferme le couvercle de sortie | ✅ | Session | Symétrique de `OpenExitCover`. Testé réel le 2026-07-29 : `result=0`, fait passer `DevStatus[RBW].st` à `1500` (= `STATE_IDLE_OCCUPY`, cohérent avec `session-lifecycle.md`) |
| `EventOfflineRecoveryOperation` | Reprise après coupure (mode hors-ligne) | ⬜ | Session (probable) | Nom WSDL confirmé uniquement ; lié au `DestinationType=1 (Server)` de `RegisterEvent` qui « enables the function of offline recovery » (`IF Spec p.90`) — lien logique, pas de détail params |
| `SetExchangeRateOperation` | Définit un taux de change | ✅ (params) / ⚠️ (échec empirique non expliqué) | Session | Lié au Result 43 "exchange rate error" observé sur Change. Params confirmés `IF Spec p.158` : `ExchangeRateSetting.ExchangeRate[]` (attrs `from`/`to`, élément `Rate`), persisté en config ("saved in the configuration file"). **Testé réel le 2026-07-29 : `result=98` "parameter error" de façon reproductible**, y compris avec `EUR→EUR rate=1` (auto-référence) et avec/sans élément `Id` explicite — cause exacte non identifiée, voir `open-questions.md` |
| `RollbackOperation` | Annule/rétablit une opération | ⬜ | Session (probable) | Nom WSDL confirmé uniquement, sémantique non extraite |
| `UpdateSettingFileOperation` | Met à jour un fichier de configuration | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |
| `SetRestrictionOperation` | Restreint l'accès à des stackers spécifiques | ✅ | Session | **« This command is valid only for RBG-200 and RBW-200 »** (`IF Spec p.160`) — sans objet sur ce prototype (RBW-100/RCW-100). Testé réel le 2026-07-29 (`stacker=1`) : `result=98` "parameter error", cohérent avec cette limitation documentée (pas de stacker de ce type sur ce matériel) |
| `GetLastResponseOperation` | Récupère la dernière réponse (probable : reprise après coupure de connexion) | ⬜ | Session (probable) | Nom WSDL confirmé uniquement — nom suggère un mécanisme de ré-obtention de réponse après timeout client, **non confirmé** |
| `RASSpecialAPIOperation` | API spéciale RAS (fonction non identifiée) | ⬜ | Inconnu | Nom WSDL confirmé uniquement, objectif non déterminé |
| `UpdateDeviceCassetteSettingOperation` | Met à jour la configuration d'une cassette dispositif | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |
| `StartSealingOperation` | Démarre une opération de scellage (probable : cassette) | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |
| `UpdateCheckOperation` | Vérifie la disponibilité d'une mise à jour | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |
| `AutoRebootChangeOperation` | Modifie la configuration de redémarrage automatique | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |
| `LanguageChangeOperation` | Change la langue de l'interface machine | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |
| `GetSettingFileOperation` | Récupère un fichier de configuration | ✅ | Session | Params confirmés `IF Spec p.176` : `FileName` (requis, ex. `GloryCo.xml`) → réponse `SettingFile` (chaîne XML brute). Testé réel le 2026-07-29 avec `FileName="GloryCo.xml"` : `result=0`, contenu XML complet reçu (config des devices RBW100/RCW100 dont ports TCP, dénominations acceptées, seuils de cassette — recoupe/confirme le contenu déjà vu via SSH, voir `development-notes.md`) |
| `UserSettingOperation` | Paramètre utilisateur (probable) | ⬜ | Session (probable) | Nom WSDL confirmé uniquement |

## Codes résultat génériques observés sur plusieurs opérations

Voir la table complète dans `error-codes.md`. Rappel des plus fréquents :
`0` succès, `21` session invalide, `22` timeout session, `40`/`41` cassette
invalide/impropre, `99` erreur programme interne, `100` erreur matérielle.

## Opérations explicitement listées comme non couvertes par une sémantique FCC

- **Aucune opération d'historique de transactions** n'existe dans cette liste de
  53 opérations — confirmé par lecture de l'IF Spec (`Status`/`Inventory` sont
  temps réel uniquement, `p.36` ; `LogRead` restitue des logs techniques, pas un
  journal métier). Voir `open-questions.md` et `development-notes.md`.

## Note sur la complétude

Les 17 opérations marquées ⬜ ci-dessus (essentiellement en fin de table WSDL,
lignes ~3058-3123) doivent être vérifiées individuellement dans `IF Spec`
(sommaire p.11-18 pour la page exacte de chacune) avant toute implémentation qui
en dépendrait. Ne pas supposer leur comportement à partir du seul nom de
l'opération.
