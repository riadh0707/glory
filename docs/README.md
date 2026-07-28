# Base de connaissances — SDK Glory ISP-K05B

Cette documentation est le résultat d'une analyse technique complète du SDK Glory
ISP-K05B v18.30 (dossier `F:\SDK_ISPK05B_v1830_20230620`, ~5,3 Go). Elle a pour
but de permettre à quiconque (humain ou nouvelle session Claude Code) de reprendre
le développement du client de paiement Glory (CI-05/CI-10/CI-10X) **sans avoir à
relire le SDK original**.

## Règle de traçabilité

Chaque affirmation technique dans ces documents cite sa source précise entre
parenthèses (nom du document + page/section, ex : `IF Spec p.90-91`,
`Sequence Spec §3.4`, `WSDL BrueBoxService.wsdl:2859`). Toute information non
confirmée par une source écrite est marquée **[hypothèse non confirmée]**.

## Sources primaires référencées dans ces documents

| Abréviation utilisée | Document réel |
|---|---|
| `WSDL BrueBoxService.wsdl` | `F:\SDK_ISPK05B_v1830_20230620\BrueBoxService.wsdl` (racine, 3674 lignes) |
| `WSDL EventService.wsdl` | `F:\SDK_ISPK05B_v1830_20230620\EventService.wsdl` (racine, 87 lignes) |
| `IF Spec` | `Doc/IF Specification Doc/ISP-K05K35ASeries_(InterfaceSpecification)_(TMB1E988-32).pdf` — 254 p., rév. 42 (2022-10-13). **Document faisant le plus autorité du SDK.** |
| `Sequence Spec` | `Doc/Sequence Diagram/CI-10_(SequenceSpecification)_(TMB1F257-01).pdf` — 57 p., réf. GTS20204-d |
| `Manual.txt` (CI-Activate) | `Manual.txt` à la racine — en réalité le manuel d'un outil tiers "CI-Activate" (Glory partner, auteur Tiago Costa), **pas un document Glory officiel** — utile en recoupement uniquement |
| `SDK Install Manual` | `SDK for FCC Installation Manual.pdf` (racine) |
| `SDKContents.pdf` | `SDKContents.pdf` (racine) |
| PosSimple 1-7 | `App/PosSimple*` — exemples client (C#, VB.NET, Java, C++) |
| PackageCreator | `App/CI10PackageCreator_Ver16.00` — outil de provisioning, pas un client transactionnel |

## Documents de ce dossier, et ordre de lecture recommandé

1. **[architecture.md](architecture.md)** — vue d'ensemble du système (FCC, caisses, VM, protocole). À lire en premier.
2. **[sdk-structure.md](sdk-structure.md)** — inventaire du contenu du SDK (dossiers, exemples, outils, simulateur).
3. **[session-lifecycle.md](session-lifecycle.md)** — cycle de vie complet d'une session caisse↔FCC (Open→Occupy→...→Close).
4. **[soap-operations.md](soap-operations.md)** — référence exhaustive des opérations SOAP (table).
5. **[event-system.md](event-system.md)** — système d'événements (double canal SOAP/TCP).
6. **[error-codes.md](error-codes.md)** — table des Result Codes.
7. **[models.md](models.md)** — fiche par modèle (CI-05, CI-10, CI-10X, CI-15, CI-50).
8. **[development-notes.md](development-notes.md)** — pièges, contradictions, décisions d'architecture recommandées.
9. **[open-questions.md](open-questions.md)** — registre des questions non résolues (constructeur / client / vérifications internes).

## Ce que cette documentation NE remplace PAS

- Les ~20 opérations SOAP dont la table de paramètres complète n'a pas été extraite
  du PDF IF Spec (listées explicitement dans `soap-operations.md`) — à approfondir
  au besoin en rouvrant `IF Spec` aux pages citées.
- La matrice complète Result Code × Commande (`IF Spec` §8, p.238-239) : la table de
  `error-codes.md` liste tous les codes et leur signification, mais l'association
  précise "quel code pour quelle commande" n'a pu être reconstruite qu'en partie
  (le tableau source s'est mal extrait du PDF — voir note dans `error-codes.md`).
- Le contenu du `Doc/Emulator Manual` (non lu en détail).
