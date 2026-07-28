# Architecture générale du système Glory

## Vue d'ensemble

```
┌─────────────────┐   SOAP/HTTPS (port 443, confirmé sur VM)     ┌──────────────────────┐
│  Caisse (Till/   │ ───────────────────────────────────────────▶ │  FCC (Front Cash /    │
│  Point of Sale)  │ ◀─────────────────────────────────────────── │  Circle Controller)   │
│                  │                                                │  ISP-K05 / ISP-K05x   │
│  client logiciel │        Canal événement (SOAP callback OU      │  = embarque un serveur │
│  développé par   │        socket TCP brut, port choisi           │  SOAP + un serveur     │
│  nous            │        par la caisse au RegisterEvent)         │  Node.js (événements)  │
└─────────────────┘ ◀─────────────────────────────────────────── │                        │
                                                                    │  pilote RBW/RCW        │
                                                                    │  (recycleurs billets/  │
                                                                    │  pièces internes)      │
                                                                    └──────────────────────┘
```
(Diagramme reconstruit à partir de `Sequence Spec §2.1 (p.6)`, qui décrit :
« FCC controls RBW and RCW cash recycler. FCC implements web server and provides
Web Services using SOAP protocol... FCC implements event notification also. That
event notification covers TCP and SOAP interface. »)

## Rôle du FCC (Front Cash/Circle Controller)

Le FCC est le contrôleur embarqué dans chaque automate Glory (CI-05/CI-10/CI-10X/
CI-50...). Il :

- expose une **interface SOAP/HTTP** (serveur Apache Axis2) permettant à un client
  externe (la caisse) de piloter les transactions (`IF Spec p.20-21`, WSDL
  `BrueBoxService.wsdl`) ;
- pilote en interne les périphériques de recyclage **RBW** (billets) et **RCW**
  (pièces), dont la variante dépend du modèle commercial (`IF Spec p.20`, voir
  `models.md`) ;
- notifie la caisse en temps réel via un **second canal**, événementiel, à choisir
  entre callback SOAP ou socket TCP brut (`Sequence Spec §2.1`, `IF Spec p.90`) ;
- tourne sur un OS Linux embarqué : confirmé indirectement par le fait que
  `PackageCreator` génère des paquets `.tar.gz` déployés au FCC via l'opération SOAP
  `StartDownloadOperation` (App/PackageCreator, WSDL) et par l'image VM du simulateur
  qui est une Ubuntu Server (`Emulator/VM Image`, voir `sdk-structure.md`).

## Rôle des caisses clientes (Till / POS)

La caisse est le logiciel que nous devons développer. Elle :

- ouvre une session SOAP (`Open`), s'enregistre comme destinataire d'événements
  (`RegisterEvent`), verrouille la machine (`Occupy`) avant toute transaction
  (`Sequence Spec §3.1`, voir `session-lifecycle.md`) ;
- pilote les scénarios métier (encaissement, rendu de monnaie, replenish, collect...)
  via des appels SOAP synchrones ;
- écoute en parallèle le canal événement pour recevoir les notifications
  asynchrones (billet détecté, distribution terminée, erreur...) — voir
  `event-system.md` ;
- doit reconstruire et persister elle-même tout historique de transactions, le FCC
  n'exposant aucune opération de requête d'historique (`IF Spec`, absence confirmée
  — voir `soap-operations.md` et `open-questions.md`).

## Rôle de la VM (simulateur FCC)

`Emulator/VM Image/ISP-K05_VER1830_VM.vmdk/.vmx` est une machine virtuelle VMware
sous **Ubuntu Server 20.04.3** (kernel 5.4.0-113-generic), réseau host-only
(`ethernet0.connectionType = "hostonly"`, `WSDL`/`.vmx` observation directe).
**IP confirmée empiriquement le 2026-07-28** (lecture directe de l'écran de
console de la VM, pas une hypothèse) : `192.168.0.25/24`, masque
`255.255.255.0`, passerelle statique (aucune), hostname `localhost`, firmware
affiché `ISP-K05B Ver.18.30R1`. **Confirmé par une seconde source
indépendante** : `SDK for FCC Installation Manual.pdf` (p.16) déclare
explicitement « The IP address of FCC is 192.168.0.25 » et prescrit de
configurer l'adaptateur host-only VMnet1 sur `192.168.0.1/255.255.255.0` (p.12)
— exactement les valeurs observées. La VM signale au démarrage des erreurs de
communication avec RBW100/RCW100 (périphériques non connectés/émulés
séparément) — cohérent avec le fait que ce firmware correspond à un FCC de
famille **CI-10** (RBW-100/RCW-100/110, voir `models.md`). L'ancienne valeur
`192.168.0.1/24` documentée ici était une estimation non confirmée par un
fichier source identifié ; **corrigée**. Le sous-réseau hôte doit être configuré
sur `192.168.0.0/24` (l'adaptateur VMware host-only par défaut de la machine de
développement n'est pas forcément sur ce sous-réseau — vérifier/reconfigurer au
besoin). Elle simule un FCC complet et expose le vrai service SOAP (confirmé
joignable en HTTPS sur le port 443, voir section "Protocole de communication"
ci-dessus), permettant de développer et tester un client de bout en bout sans
matériel physique. Elle est distincte des émulateurs de périphériques
Windows-only (`RBW10Sim.exe`, `RCW50Sim.exe`, etc., voir `sdk-structure.md`),
qui simulent uniquement le comportement bas niveau des recycleurs.

## Protocole de communication

- **Transport principal** : SOAP 1.1 document/literal. Le WSDL du SDK documente un
  endpoint type `http://service.bruebox.com:9090/axis2/services/BrueBoxService`
  en clair sur le port 9090 (`WSDL BrueBoxService.wsdl`, `WSDL EventService.wsdl`),
  et l'`IF Spec` ne mentionne aucune trace de HTTPS/TLS pour ce canal (recherche
  exhaustive négative). **Correction empirique (vérifiée sur la VM simulateur le
  2026-07-28, pas une hypothèse)** : la VM `ISP-K05_VER1830_VM` (firmware
  `ISP-K05B Ver.18.30R1`) sert en réalité `BrueBoxService` via **Axis2C (moteur
  Axis2 en C, pas Java) en HTTPS sur le port 443**, endpoint
  `https://<ip-fcc>/axis2/services/BrueBoxService`, certificat auto-signé (accès
  testé avec succès via `curl -k` et confirmation que le WSDL servi est
  strictement identique à la copie racine du SDK — diff vide sur la liste des 53
  opérations). Le port 9090/HTTP du WSDL est donc une valeur d'exemple/legacy, pas
  la configuration réelle du firmware 18.30. **Le port et le protocole réels
  peuvent varier par déploiement/version de firmware — à confirmer sur chaque
  environnement cible (simulateur ou matériel réel) plutôt que de coder le port en
  dur.** Un serveur web de configuration (page `LOGIN`) répond aussi sur `/` du
  même hôte HTTPS — probablement une interface d'administration séparée, non
  utilisée par le client transactionnel.
- **Authentification** : quasi inexistante par conception — `LoginUserRequest` :
  « There is no authentication function » (`IF Spec p.97`) ; le mot de passe
  d'`OpenRequest` n'est vérifié que si l'option serveur « User check » est activée,
  désactivée par défaut (`IF Spec p.114`). **Vérifié le 2026-07-28 sur la VM
  simulateur : "User check" y était activé** (`SoapUserCheck=1` dans
  `FunctionSetting.xml`, contraire au défaut documenté), ce qui a bloqué tout
  `Open` jusqu'à correction — voir `open-questions.md` et
  `development-notes.md` pour le détail complet. **Implication sécurité** :
  voir `development-notes.md`.
- **Verrouillage machine** : `Occupy`/`Release`, un verrou de disponibilité (pas de
  sécurité) posé une fois par session, pas par transaction (`Sequence Spec §3.1`,
  `IF Spec p.118-121`) — voir `session-lifecycle.md`.
- **Événements** : double canal officiel (callback SOAP `EventService.wsdl`
  `BbxEventOperation`, ou socket TCP brut), sélectionné par la caisse au moment de
  `RegisterEvent` via le couple `Url`/`Port` fourni — voir `event-system.md`.

## Composants importants du SDK

Voir le détail dans `sdk-structure.md`. Résumé :

| Composant | Rôle |
|---|---|
| `BrueBoxService.wsdl` (racine) | Définition SOAP complète, 53 opérations — la source de vérité pour le contrat client↔FCC |
| `EventService.wsdl` (racine) | Définition du service SOAP côté client pour recevoir les callbacks d'événements |
| `Doc/IF Specification Doc` | Spécification d'interface officielle (254 p.) — sémantique exacte des opérations |
| `Doc/Sequence Diagram` | Séquences métier complètes (Cash In, Change, Collect, etc.) |
| `App/PosSimple 1-7` | Exemples client (majoritairement Windows/.NET Framework legacy) |
| `App/CI10PackageCreator` | Outil de provisioning (configuration langue/devise), pas un client transactionnel |
| `Emulator/VM Image` | Simulateur FCC complet (Ubuntu) |
| `Emulator/Device Emulator` | Simulateurs de périphériques RBW/RCW (Windows only) |
