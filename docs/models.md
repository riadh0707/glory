# Fiches par modèle

Source principale : `IF Spec` Préface (p.20) —

> « This document describes SOAP Interface of 'CI-10(ISP-K05/A/B/C)' and
> 'CI-50(ISP-K05D/E) and 'CI-5(ISP-K05F/G) and 'CI-10X(ISP-K05H)'... 'CI-10
> (ISP-K05/A/B/C)' controls RBW-100, RZ-50 or RBG-200 and RCW-100/110.
> 'CI-50(ISP-K05D/E)' controls RBW-150 and RCW-100/110. 'CI-5(ISP-K05F)'
> controls RBW-50 and RCW-50. 'CI-10X(ISP-K05H)' controls RBW-200 and RCW-200. »

Complétée par l'historique de révisions de l'IF Spec (ajout de "CI-5X" en
révision 18, 2019) et par `Manual.txt` (document tiers CI-Activate) pour les
points de recoupement UX.

## CI-05 (nom commercial) / CI-5 (ISP-K05F/G) dans l'IF Spec

- **Fonctionnalités** : interface SOAP identique à CI-10/CI-50/CI-10X selon
  l'IF Spec (`p.20`) — mêmes 53 opérations `soap-operations.md`, même mécanisme
  de session/Occupy/événements.
- **Matériel piloté** : RBW-50 et RCW-50 (`IF Spec p.20`).
- **Limitations** : aucune limitation fonctionnelle spécifique documentée dans
  l'IF Spec au-delà du matériel piloté.
- **Ambiguïté majeure — non résolue** : le SDK contient des bibliothèques
  fermées `FccWebsockLib.dll` (.NET) et `FccInterfaceLib.jar` (Java), avec
  sérialisation JSON (Newtonsoft.Json / Jackson), suggérant un protocole
  **WebSocket propriétaire** distinct du SOAP pour ce modèle — observation
  faite sur les guides APG (Application Programming Guide) et le contenu du
  SDK, mais **directement contredite par l'IF Spec** qui place CI-5 sous
  interface SOAP. Deux lectures possibles, aucune confirmée par une source
  écrite univoque :
  1. Le WebSocket concerne une révision matérielle CI-5 plus récente non
     couverte par cette édition de l'IF Spec (rév. 42) — l'ajout de "CI-5X" en
     rév. 18 (2019) suggère une évolution de gamme postérieure au cœur du
     document.
  2. Les deux mécanismes coexistent selon le firmware installé.
  **[hypothèse non confirmée — voir open-questions.md, question bloquante
  pour toute intégration CI-05]**
- **État du support dans ce SDK** : documentation SOAP complète et fiable
  (IF Spec), mais la piste WebSocket, si elle s'applique au matériel réel du
  client, resterait non documentée par un schéma ouvert (pas de WSDL/spec
  publiée, uniquement des binaires fermés).

## CI-10 (ISP-K05/A/B/C)

- **Fonctionnalités** : couverture la plus complète et la plus détaillée du
  SDK — la `Sequence Spec` (CI-10_(SequenceSpecification)) est explicitement
  écrite pour ce modèle, et sert de référence pour le cycle de vie de session
  documenté dans `session-lifecycle.md`.
- **Matériel piloté** : RBW-100, RZ-50 ou RBG-200, et RCW-100/110
  (`IF Spec p.20`).
- **Limitations connues** : aucune limitation fonctionnelle spécifique
  documentée au-delà des codes d'erreur génériques (`error-codes.md`).
- **Point UX de recoupement (source tierce)** : `Manual.txt` (CI-Activate,
  document non-Glory) indique que le menu "Unlock" n'est visible que sur
  CI-10 ou CI-50 dans ce logiciel tiers — cohérent avec l'existence des
  opérations `LockUnitOperation`/`UnLockUnitOperation` dans le WSDL, mais ce
  n'est pas une confirmation Glory de premier rang de leur disponibilité
  exclusive sur CI-10/CI-50.
- **État du support** : le mieux documenté des 4 modèles couverts par l'IF
  Spec.

## CI-10X (ISP-K05H)

- **Fonctionnalités** : même interface SOAP que CI-10/CI-50/CI-5
  (`IF Spec p.20`).
- **Matériel piloté** : RBW-200 et RCW-200 (`IF Spec p.20`).
- **Limitations / différences connues** : aucune différence fonctionnelle
  spécifique documentée au-delà du matériel piloté — les sous-modules
  `RomVersionResponseType` incluent explicitement `RBW200`/`RCW200`
  (`WSDL BrueBoxService.wsdl` lignes 946-947), confirmant sa prise en charge
  au niveau protocole.
- **Ambiguïtés restantes** : aucune identifiée au-delà de celles communes à
  tous les modèles (timeout Occupy non documenté, ports SOAP non fixés dans
  l'IF Spec).
- **État du support** : bien documenté au niveau protocole (IF Spec), mais
  aucun exemple de code spécifique à ce modèle identifié dans `App/PosSimple`.

## CI-15

- **Fonctionnalités** : **aucune** — ce modèle n'apparaît nulle part dans
  l'IF Spec (titre, préface, historique de révisions, tableaux de modèles) ni
  dans les guides APG, ni dans les spécifications de codes d'erreur du SDK.
- **Limitations** : sans objet — aucune donnée technique disponible.
- **Différences connues** : sans objet.
- **Ambiguïtés restantes** : `Manual.txt` (document tiers CI-Activate, pas
  Glory) le cite explicitement comme gamme Glory existante ("CI-5, CI-10, CI-15
  et CI-50"), ce qui crée une contradiction non résolue entre une source tierce
  et l'absence totale de documentation Glory officielle dans ce SDK.
- **État du support : non couvert par ce SDK.** Ne pas développer de code
  spécifique CI-15 sans documentation constructeur dédiée — voir
  `open-questions.md` (question bloquante si le parc client inclut du CI-15).

## CI-50 (ISP-K05D/E)

- **Fonctionnalités** : même interface SOAP que CI-10/CI-10X/CI-5
  (`IF Spec p.20`).
- **Matériel piloté** : RBW-150 et RCW-100/110 (`IF Spec p.20`).
- **Limitations / différences connues** : le code `44 "Counted Category2"` est
  spécifiquement associé à RBW150/RBW50 dans une observation antérieure de
  l'analyse — **à reconfirmer**, ce détail n'a pas été retrouvé littéralement
  dans les pages de l'IF Spec relues pour cette documentation.
- **Point UX de recoupement (source tierce)** : comme CI-10, le menu "Unlock"
  serait visible sur CI-50 selon `Manual.txt` (document tiers).
- **État du support** : bien documenté au niveau protocole (IF Spec).

## Tableau de synthèse

| Modèle | Réf. interne | Matériel (RBW/RCW) | Interface documentée | Statut documentation |
|---|---|---|---|---|
| CI-05/CI-5 | ISP-K05F/G | RBW-50, RCW-50 | SOAP (IF Spec) — **mais ambiguïté WebSocket non résolue** | Bonne (SOAP) + lacune (WebSocket) |
| CI-10 | ISP-K05/A/B/C | RBW-100, RZ-50 ou RBG-200, RCW-100/110 | SOAP | Excellente (référence principale du SDK) |
| CI-10X | ISP-K05H | RBW-200, RCW-200 | SOAP | Bonne |
| CI-15 | — | — | **Aucune** | **Absente — non couvert par ce SDK** |
| CI-50 | ISP-K05D/E | RBW-150, RCW-100/110 | SOAP | Bonne |
