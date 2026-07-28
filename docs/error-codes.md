# Table des Result Codes

Source : `IF Spec §8 "Result Code Matrix" (p.238-239)`, recoupée avec les codes
observés par opération dans `soap-operations.md` et `session-lifecycle.md`.

## Note sur l'extraction

Le "Result Code Matrix" du PDF source est un tableau croisé **Code × Commande**
(46 commandes en colonnes/lignes, ~30 codes). L'extraction texte (`pdftotext
-layout`) a perdu la structure de grille du tableau — seule la **liste complète
des codes avec leur signification** a pu être reconstruite de façon fiable
(colonne "STATUS" du tableau source, p.238-239). **L'association précise
"quel code s'applique à quelle commande" n'est disponible que pour les
opérations déjà documentées individuellement** dans `soap-operations.md`
(Change, Cashout, Collect, Occupy, Open...). Pour les opérations non détaillées,
ne pas supposer quels codes s'appliquent — consulter l'IF Spec p.238-239
directement si besoin.

## Table complète des codes (IF Spec p.238-239)

| Code | Signification (IF Spec) | Quand il apparaît (connu) | Comment le gérer côté client |
|---|---|---|---|
| 0 | success | Toute opération | Poursuivre le flux normal |
| 1 | cancel | Change (annulation) | Traiter comme annulation utilisateur, pas une erreur |
| 2 | reset | Change | Machine réinitialisée pendant l'opération — resynchroniser l'état (`Status`/`Inventory`) |
| 3 | occupied by other | Occupy | Un autre client détient le verrou — attendre/retenter, informer l'opérateur |
| 4 | occupation not available | Occupy | Occupy indisponible — vérifier l'état machine (`Status`) avant retry |
| 5 | not occupied | Opérations nécessitant Occupy | Appeler `Occupy` avant de retenter |
| 6 | designation denomination shortage | Change | Pénurie sur une dénomination demandée — proposer une alternative ou interrompre |
| 9 | cancel change shortage | Change (annulation) | Manque de monnaie lors d'une annulation — nécessite intervention (replenish) |
| 10 | change shortage | Change/Cashout | Pénurie générale de monnaie — déclencher un replenish |
| 11 | exclusive error | Change (probable, cf. accès concurrent) | Erreur d'exclusivité — vérifier l'état du verrou Occupy |
| 12 | dispensed change inconsistency | Change/Cashout | Incohérence de distribution — `Reset` + `Verify-Collect` + replenish recommandés (`Sequence Spec §3.8`) |
| 13 | auto recovery failure | Change | Échec de l'auto-récupération — nécessite un `Reset` manuel + intervention |
| 15 | user authentication failure | Open | Échec si "User check" est activé côté serveur — vérifier les identifiants |
| 16 | number of session over | Open | Trop de sessions simultanées — fermer une session existante avant retry |
| 17 | occupied by itself | Occupy | Ré-occupation par le même titulaire — traiter comme succès idempotent |
| 20 | session not available | Open | Session indisponible — retry après délai |
| 21 | invalid session | Toute opération avec SessionID | Réouvrir une session (`Open`) |
| 22 | session timeout | Toute opération avec SessionID | Réouvrir une session ; durée du timeout non documentée (voir `open-questions.md`) |
| 26 | manual deposit disagreement | Opérations de dépôt manuel | Écart détecté — nécessite vérification manuelle |
| 32 | verify collect/replenish failed | Replenishment(Cassette) | Notes non acceptées, flag de vérification requis sur cassette (`Sequence Spec §3.13-3.14`) — les pièces restent acceptées |
| 33 | IF cassette illegal denomination | Replenishment(Cassette) | Mauvaise dénomination assignée, ou stacker plein (`Sequence Spec §3.13-3.14`) |
| 34 | shortage of capacity of stacker | Opérations d'empilage | Capacité insuffisante — déclencher un collect |
| 35 | CI-Server communication error | Collect (remain-setting sync) | Échec de synchronisation avec CI-Server — repli sur la valeur courante (`Sequence Spec §3.16-3.17`) |
| 36 | number of registration over | RegisterEvent | Plus de 4 destinations déjà enregistrées — désenregistrer une destination avant retry |
| 40 | invalid cassette number | Cash In, Replenishment, Collect | Cassette invalide — vérifier la configuration physique |
| 41 | improper cassette | Change/Cashout | Cassette inadaptée à l'opération |
| 43 | exchange rate error | Change | Erreur de taux de change — vérifier `SetExchangeRate` |
| 44 | Counted Category2 | Change | Note catégorie 2 (suspecte contrefaçon) comptée — RBW150/RBW50 uniquement selon note antérieure — à reconfirmer |
| 96 | Duplicate Transaction | Change/toute opération transactionnelle | Transaction dupliquée détectée (probable rejeu de requête) — ne pas retraiter, vérifier idempotence côté client |
| 98 | parameter error (type error) | Toute opération | Erreur de type de paramètre — bug côté client à corriger, pas un cas à gérer en run-time |
| 99 | program inner error | Toute opération | Erreur interne au programme FCC — logger et alerter, cas anormal |
| 100 | device error | Change/Cashout/Collect | Erreur matérielle non auto-récupérable — `Reset` + intervention technique |

## Catégories de notes/pièces (IF Spec §9, p.241-242)

Utilisées dans les événements `eventCounted/RequireVerifyCategoryNote` et le
code `44` ci-dessus. Classification définie par la Banque Centrale Européenne :

| Catégorie | Description |
|---|---|
| Category1 | Non reconnu comme billet/pièce euro (image/format erroné, grand coin manquant, billet manuscrit, devise non-euro) |
| Category2 | Suspecté de contrefaçon (image/format reconnu, mais une ou plusieurs caractéristiques d'authentification manquantes ou hors tolérance) |
| Category3 | Non authentifié avec certitude (image/format reconnu, mais authentification incomplète pour raison de qualité/usure) |
| Category4a | Authentique et en bon état (tous les contrôles positifs) |
| Category4b | Authentique mais usé (authentification positive, contrôles de qualité négatifs) |

## Logique générale de traitement recommandée

Déduite des séquences d'erreur documentées (`Sequence Spec §3.3, §3.7, §3.8,
§3.10, §3.12, §3.14, §3.17`) :

1. **Auto-récupération** : certaines erreurs sont gérées automatiquement par le
   FCC (le "Hold Error" suspend la notification d'événement pendant
   l'auto-récupération, `Sequence Spec §3.3`) — le client doit attendre avant
   de conclure à un échec définitif.
2. **Reset manuel requis** : si l'auto-récupération échoue (code `13`), ou pour
   les erreurs matérielles (`100`), le client doit appeler `Reset` explicitement.
3. **Replenish/Collect requis** : pénuries (`6`, `9`, `10`) ou incohérences de
   distribution (`12`) nécessitent une action opérateur physique (réapprovisionner
   ou vider une cassette) avant de pouvoir retenter l'opération.
4. **Erreurs de session/verrou** (`3`, `4`, `5`, `16`, `17`, `20`, `21`, `22`) :
   gérées entièrement côté logique de session client — voir
   `session-lifecycle.md`.
