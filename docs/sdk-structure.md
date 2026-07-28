# Structure du SDK

Racine : `F:\SDK_ISPK05B_v1830_20230620` — taille totale ~5,3 Go (observation
directe de l'arborescence, `du -sm` par dossier).

## Fichiers racine

| Fichier | Rôle |
|---|---|
| `BrueBoxService.wsdl` | Définition SOAP complète du service FCC — **53 opérations**, source de vérité du contrat client↔FCC. Existe aussi en copies partielles dans certains exemples `App/PosSimple*` avec un nombre d'opérations variable (18 à 49 selon la version) — **toujours préférer cette copie racine, la plus complète (v18.30)**. |
| `EventService.wsdl` | Définition SOAP du service client recevant les callbacks d'événements (`BbxEventOperation`) — voir `event-system.md`. |
| `Manual.txt` | En réalité le manuel de **CI-Activate v1.5**, un outil tiers (Glory partner, auteur Tiago Costa) — **pas un document Glory officiel**. Utile en recoupement (config.ini, séquence de démarrage, menu Unlock par modèle) mais jamais comme source primaire. |
| `SDK for FCC Installation Manual.pdf` | Procédure d'installation du SDK — lu partiellement lors de l'analyse initiale. |
| `SDKContents.pdf` | Sommaire du contenu du package — lu partiellement. |

## Dossier `App/` (~164 Mo)

| Sous-dossier | Rôle |
|---|---|
| `PosSimple 1` à `PosSimple 7` | Exemples client, langages variés (C#/.NET Framework/WinForms, VB.NET/WinForms, Java/Axis2, C++/gSOAP). Fichiers clés : `Form1.vb`, `EventHandleClass.vb`/`.cs`, `FCCClient.java`, `BrueBoxServiceStub.java`, `Client.cpp`, `soapStub.h`, `FccOperator.cs`, `FccObject.cs`, `FccEvent.cs`, `FccConst.cs`. **Majoritairement Windows-only / legacy** — voir `development-notes.md` pour l'implication sur le choix de langage. |
| `CI10PackageCreator_Ver16.00` | Outil Windows de provisioning : génère des paquets `.tar.gz` de configuration langue/devise, déployés au FCC via l'opération SOAP `StartDownloadOperation`. **Ce n'est pas un client transactionnel** — confirme cependant que le firmware FCC est Linux-embarqué. |

## Dossier `Doc/` (~238 Mo)

| Sous-dossier | Rôle |
|---|---|
| `APG` (Application Programming Guide) | Guides par langage/modèle — source de l'observation WebSocket pour CI-5 (bibliothèques `FccWebsockLib.dll`/`FccInterfaceLib.jar`), à recouper avec l'IF Spec (voir `models.md`, ambiguïté CI-05). |
| `Emulator Manual` | Manuel de l'émulateur — **non lu en détail** dans cette analyse, à approfondir avant tests d'erreurs fines sur simulateur. |
| `ErrorCode Specification` | Spécifications de codes d'erreur, **par modèle** — confirme les différences per-modèle observées (ex. code `44` associé à RBW150/RBW50). |
| `IF Specification Doc` | **`ISP-K05K35ASeries_(InterfaceSpecification)_(TMB1E988-32).pdf`, 254 p.** — document faisant le plus autorité du SDK, base de `soap-operations.md`, `error-codes.md`, `event-system.md`, `session-lifecycle.md`. |
| `Screen Specification` | Spécification des écrans machine — non exploitée dans cette analyse (hors périmètre du client transactionnel). |
| `Sequence Diagram` | **`CI-10_(SequenceSpecification)_(TMB1F257-01).pdf`, 57 p.** — séquences métier complètes, base de `session-lifecycle.md`. Note : les diagrammes de séquence eux-mêmes sont des graphiques vectoriels dans le PDF et ne s'extraient pas en texte (seules les sections "Outline" en prose et la séquence 3.1 se sont extraites proprement) — voir `development-notes.md`. |

## Dossier `Emulator/` (~4 866 Mo — le plus volumineux du SDK)

| Sous-dossier | Rôle |
|---|---|
| `Device Emulator` (RBW-50/100/150/200, RCW-50/100/200) | Exécutables Windows simulant le comportement bas niveau des recycleurs physiques (`RBW10Sim.exe`, `RBW100Sim.exe`, `RBW150Sim.exe`, `RCW50Sim.exe`, `RCW100Sim.exe`, `RCW200Sim.exe`, etc.). **Windows uniquement**, complémentaires de la VM plutôt que substituables. |
| `VM Image` | `ISP-K05_VER1830_VM.vmdk`/`.vmx` — machine virtuelle VMware, **Ubuntu Server 20.04.3** (kernel 5.4.0-113-generic), réseau host-only `192.168.0.1/24`. **Simule un FCC complet**, service SOAP réel inclus — utilisable pour développer un client de bout en bout sans matériel physique. Voir `architecture.md`. |

## WSDL et bibliothèques

| Élément | Détail |
|---|---|
| `BrueBoxService.wsdl` | SOAP 1.1 document/literal, endpoint type `http://service.bruebox.com:9090/axis2/services/BrueBoxService`, serveur Apache Axis2 côté FCC. |
| `EventService.wsdl` | Service client pour callback SOAP d'événements. |
| `FccWebsockLib.dll` (.NET) | Bibliothèque fermée pour un protocole WebSocket propriétaire — présente dans le SDK côté guides/bibliothèques CI-5, **sans schéma/source publié**. Sérialisation JSON via Newtonsoft.Json. |
| `FccInterfaceLib.jar` (Java) | Équivalent Java de la bibliothèque WebSocket ci-dessus, sérialisation JSON via Jackson. |

## Outils

| Outil | Rôle |
|---|---|
| `CI10PackageCreator` | Provisioning de configuration (langue/devise) — voir ci-dessus. |
| Émulateurs de périphériques (`*Sim.exe`) | Simulation bas niveau RBW/RCW, Windows uniquement. |
| VM Image | Simulateur FCC complet, Ubuntu — voir ci-dessus. |

## Fichiers par extension (échantillon observé)

188 fichiers `datasource` (config PackageCreator), 105 `.dll`, 96 `.xml`,
47 `.cs`, 21 `.pdf`, 20 `.java`, 16 `.exe`, 16 `.zip`, 16 `.resx`, 15 `.vb`,
8 `.config`, 7 `.wsdl`, 6 `.jar`, 5 `.sln`, 5 `.h`.
