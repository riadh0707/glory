import * as soap from "soap";
import axios from "axios";
import * as https from "https";
import * as path from "path";
import { describeResultCode } from "./result-codes";

/**
 * Chemin vers la copie du WSDL utilisée par le client — copiée depuis la
 * racine du SDK (`BrueBoxService.wsdl`, seule copie complète du SDK, voir
 * docs/development-notes.md "Piège n°1") vers `dist/resources/` au moment du
 * build (voir script `build` de package.json). **Ne plus référencer la
 * racine du SDK directement par un chemin relatif** (`../../../../`) : ça
 * fonctionnait en dev mais casse une fois l'app empaquetée, le dossier
 * `client/` étant le seul inclus dans le paquet — la racine du SDK, elle,
 * n'existe pas chez le client final. Bug réel rencontré le 2026-07-29 en
 * testant `release/win-unpacked/*.exe` (voir aussi le piège similaire sur
 * `DATA_DIR` dans `main.ts`).
 */
const WSDL_PATH = path.resolve(__dirname, "../../resources/BrueBoxService.wsdl");

export type LogDirection = "request" | "response";
export type SoapLogger = (direction: LogDirection, operation: string, payload: unknown) => void;

export interface SoapClientConfig {
  /** Endpoint SOAP réel du FCC (ex. VM simulateur). Remplace le soap:address
   * placeholder du WSDL, qui ne correspond pas à un déploiement réel — voir
   * docs/architecture.md, section "Protocole de communication". */
  endpoint: string;
  /** false si le FCC présente un certificat auto-signé (cas de la VM
   * simulateur, voir docs/architecture.md) — à mettre à true avec un vrai
   * certificat de confiance en production. */
  rejectUnauthorized: boolean;
  logger: SoapLogger;
}

export interface OpenResult {
  result: number;
  resultDescription: string;
  sessionId: string | undefined;
}

export interface SimpleResult {
  result: number;
  resultDescription: string;
}

/**
 * Extrait l'attribut `result` d'une réponse SOAP.
 *
 * Le WSDL déclare `result` comme un attribut XML (`<xsd:attribute
 * ref="xsd1:result"/>`, pas un élément) sur chaque complexType `*ResponseType`
 * — voir docs/soap-operations.md. La lib "soap" place les attributs XML sous
 * une clé `attributes`, et le serveur Axis2C de la VM renvoie cet attribut
 * avec un préfixe de namespace (observé empiriquement le 2026-07-28 :
 * `attributes["n:result"]`, pas `attributes.result` ni `result` à plat).
 * Cette fonction tolère les deux formes plutôt que de supposer laquelle sera
 * utilisée par un FCC physique.
 */
function extractResultAttribute(response: { attributes?: Record<string, unknown>; result?: unknown }): number {
  const candidates = [
    response.result,
    response.attributes?.["result"],
    response.attributes?.["n:result"],
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      const parsed = Number(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  throw new Error(
    `Impossible d'extraire l'attribut "result" de la réponse SOAP : ${JSON.stringify(response)}`
  );
}

/** Une ligne de dénomination pour `CollectOperation` — reprend exactement la
 * structure `<Denomination cc="EUR" fv="100" devid="2"><Piece>1</Piece>
 * <Status>0</Status></Denomination>` de l'exemple IF Spec p.82. Aucune valeur
 * "collecter tout" n'est documentée dans l'IF Spec (les sections lues à ce
 * jour n'en montrent aucune) — le WSDL exige `Cash` avec au moins une
 * dénomination explicite (`minOccurs="1"`), donc l'appelant doit toujours
 * lister ce qu'il veut collecter plutôt que de s'appuyer sur un raccourci
 * "tout" non confirmé. */
export interface CollectDenomination {
  cc: string;
  fv: string;
  devid: string;
  piece: number;
}

export interface RegisterEventParams {
  sessionId: string;
  /** URL du destinataire d'événements. Pour le mode TCP brut (voir
   * docs/event-system.md), ce n'est pas une URL HTTP mais l'adresse IP de la
   * caisse — le FCC ouvrira une connexion TCP vers `url:port`. */
  url: string;
  port: number;
}

/**
 * Client SOAP pour BrueBoxService. N'expose jamais l'objet `soap.Client` brut
 * à l'extérieur du module — uniquement des fonctions async par opération
 * métier, chacune documentée avec sa référence exacte dans
 * docs/soap-operations.md.
 */
export class FccSoapClient {
  private client: soap.Client;
  private readonly logger: SoapLogger;
  private seqCounter = 0;

  private constructor(client: soap.Client, logger: SoapLogger) {
    this.client = client;
    this.logger = logger;
  }

  static async create(config: SoapClientConfig): Promise<FccSoapClient> {
    // La lib "soap" 1.10.x transporte les requêtes via une instance axios
    // interne ; un `rejectUnauthorized` passé au niveau racine de IOptions
    // n'est PAS forwardé à cette instance (vérifié empiriquement : échoue
    // avec DEPTH_ZERO_SELF_SIGNED_CERT contre la VM simulateur, qui présente
    // un certificat auto-signé — docs/architecture.md). La méthode
    // documentée par soap.d.ts pour contrôler le TLS est de fournir sa
    // propre instance axios via l'option `request`.
    const axiosInstance = axios.create({
      httpsAgent: new https.Agent({ rejectUnauthorized: config.rejectUnauthorized }),
    });
    const client = await soap.createClientAsync(WSDL_PATH, {
      endpoint: config.endpoint,
      request: axiosInstance,
    });
    // Le WSDL documente un soap:address placeholder
    // (http://service.bruebox.com:9090/...) qui ne correspond à aucun
    // déploiement réel connu — on force l'endpoint réel explicitement.
    client.setEndpoint(config.endpoint);
    return new FccSoapClient(client, config.logger);
  }

  private nextSeqNo(): string {
    this.seqCounter += 1;
    return String(this.seqCounter);
  }

  private async call<TArgs, TResult>(operation: string, args: TArgs): Promise<TResult> {
    // SessionID vide = terminal en "Session mode" désactivé : l'élément doit
    // alors être omis (optionnel partout dans le WSDL), pas envoyé vide.
    const record = args as unknown as Record<string, unknown>;
    if (record && record.SessionID === "") {
      delete record.SessionID;
    }
    this.logger("request", operation, args);
    const method = (this.client as unknown as Record<string, (a: TArgs) => Promise<[TResult, string]>>)[
      `${operation}Async`
    ];
    if (!method) {
      throw new Error(
        `Opération SOAP "${operation}" introuvable sur le client généré depuis le WSDL — ` +
          `elle n'existe probablement pas dans BrueBoxService.wsdl (voir docs/soap-operations.md).`
      );
    }
    const [result] = await method.call(this.client, args);
    this.logger("response", operation, result);
    return result;
  }

  /**
   * Ouvre une session. Réf. docs/soap-operations.md, ligne 21 ("OpenOperation
   * | Ouvre une session, obtient un SessionID"). Champs requête : WSDL
   * BrueBoxService.wsdl:205-214 (complexType OpenRequestType — Id?, SeqNo,
   * User, UserPwd, DeviceName, CustomId?).
   */
  async open(userId: string, userPwd: string, deviceName: string): Promise<OpenResult> {
    type OpenResponse = { attributes?: Record<string, unknown>; SessionID?: string };
    const response = await this.call<
      { SeqNo: string; User: string; UserPwd: string; DeviceName: string },
      OpenResponse
    >("OpenOperation", {
      SeqNo: this.nextSeqNo(),
      User: userId,
      UserPwd: userPwd,
      DeviceName: deviceName,
    });
    const result = extractResultAttribute(response);
    return {
      result,
      resultDescription: describeResultCode(result),
      sessionId: response.SessionID,
    };
  }

  /**
   * Enregistre une destination d'événements. Réf. docs/soap-operations.md,
   * ligne 36 ("RegisterEventOperation | Enregistre une destination
   * d'événements"). Champs requête : WSDL BrueBoxService.wsdl:800-813
   * (RegisterEventRequestType — Id?, SeqNo, SessionID?, Url, Port?,
   * DestinationType?, Encryption?, RequireEventList?, TillID?).
   *
   * `RequireEventList` est volontairement omis (optionnel dans le WSDL,
   * minOccurs="0") — son absence signifie s'abonner au comportement par
   * défaut du FCC, non détaillé dans docs/event-system.md. À affiner si le
   * FCC ne notifie pas les événements attendus.
   */
  async registerEvent(params: RegisterEventParams): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Url: string; Port: string },
      { attributes?: Record<string, unknown> }
    >("RegisterEventOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: params.sessionId,
      Url: params.url,
      Port: String(params.port),
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /** Supprime une destination d'événements (WSDL BrueBoxService.wsdl:828-836
   * — SeqNo, SessionID?, Url, Port?). Le terminal n'en garde que 4. */
  async unRegisterEvent(params: RegisterEventParams): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Url: string; Port: string },
      { attributes?: Record<string, unknown> }
    >("UnRegisterEventOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: params.sessionId,
      Url: params.url,
      Port: String(params.port),
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Verrouille la machine en exclusivité. Réf. docs/soap-operations.md, ligne
   * 23 ("OccupyOperation | Verrouille la machine en exclusivité"). Champs
   * requête : WSDL BrueBoxService.wsdl:427-434 (OccupyRequestType — Id?,
   * SeqNo, SessionID?, OccupyImg?).
   */
  async occupy(sessionId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("OccupyOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * État courant temps réel. Réf. docs/soap-operations.md, ligne 25
   * ("GetStatus | État courant temps réel"). Champs requête : WSDL
   * BrueBoxService.wsdl:179-187 (StatusRequestType — Id?, SeqNo, SessionID?,
   * Option [requis, attribut `type`:int — signification exacte non détaillée
   * dans docs/soap-operations.md, valeur 0 utilisée par défaut, voir
   * docs/open-questions.md], RequireVerification?).
   *
   * Ne pas appeler en polling continu — déconseillé explicitement par le
   * constructeur (IF Spec p.36, cité dans docs/soap-operations.md).
   */
  async getStatus(sessionId: string): Promise<{ result: number; resultDescription: string; raw: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("GetStatus", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: 0 } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), raw: response };
  }

  /**
   * Libère le verrou Occupy. Réf. docs/soap-operations.md, ligne 24
   * ("ReleaseOperation | Libère le verrou Occupy"). Champs requête : WSDL
   * BrueBoxService.wsdl:449-455 (ReleaseRequestType — Id?, SeqNo, SessionID?).
   */
  async release(sessionId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("ReleaseOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Ferme la session. Réf. docs/soap-operations.md, ligne 22 ("CloseOperation
   * | Ferme la session"). Champs requête : WSDL BrueBoxService.wsdl:230-236
   * (CloseRequestType — Id?, SeqNo, SessionID?).
   */
  async close(sessionId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("CloseOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Démarre un cycle d'encaissement (ouvre l'accepteur billets/pièces).
   * Réf. docs/soap-operations.md, ligne 28 ("StartCashinOperation | Démarre
   * un cycle d'encaissement"). Champs requête : WSDL
   * BrueBoxService.wsdl:306-314 (StartCashinRequestType — Id?, SeqNo,
   * SessionID?, Option? [attribut `type` : 0=Both, 1=Bill, 2=Coin — IF Spec
   * p.51-52], ForeignCurrency?).
   *
   * `deviceType` correspond à `Option.type` (défaut 0 = "Both", accepte
   * billets et pièces) ; `ForeignCurrency` est omis (optionnel, non couvert
   * par ce sprint).
   */
  async startCashin(sessionId: string, deviceType: 0 | 1 | 2 = 0): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("StartCashinOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: deviceType } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Termine un cycle d'encaissement et restitue le détail des espèces
   * réellement comptées. Réf. docs/soap-operations.md, ligne 29
   * ("EndCashinOperation | Termine un cycle d'encaissement"). Champs
   * requête : WSDL BrueBoxService.wsdl:329-336 (EndCashinRequestType — Id?,
   * SeqNo, SessionID?, Option? [attribut `type` : 0=acquisition normale de
   * l'inventaire, 1=accélérée — IF Spec p.54]). Renvoie `result=11 "exclusive
   * error"` si aucun `StartCashin` n'était en cours (IF Spec p.54, "Except
   * the device is in the middle of the cash in transaction, returns
   * exclusive error").
   *
   * **Correction empirique (2026-07-28)** : `ManualDeposit` n'est PAS le
   * montant physiquement compté — le WSDL le documente comme "Manual handing
   * amount by UpdateManualDepositTotal" (une saisie manuelle distincte, hors
   * périmètre de ce sprint) et il reste à `0` même avec un vrai billet
   * inséré dans l'émulateur (testé RBWXSim, un billet EUR ajouté via son
   * dialogue "Set bill dialog for Entrance"). **Le détail réel du dépôt
   * physique est dans `Cash.Denomination`** (`cc`, `fv`, `rev`, `devid` en
   * attributs ; `Piece`, `Status` en éléments) — confirmé peuplé
   * correctement dans ce même test. `cash` ci-dessous expose cette structure
   * brute (non typée finement — `Denomination` peut être un objet unique ou
   * un tableau selon le nombre de dénominations, particularité de la lib
   * `soap` non normalisée ici).
   */
  async endCashin(
    sessionId: string
  ): Promise<SimpleResult & { manualDeposit: string | undefined; cash: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown>; ManualDeposit?: string; Cash?: unknown }
    >("EndCashinOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return {
      result,
      resultDescription: describeResultCode(result),
      manualDeposit: response.ManualDeposit,
      cash: response.Cash,
    };
  }

  /**
   * Encaissement + rendu de monnaie en un seul appel — opération autonome et
   * **bloquante**, sans besoin de StartCashin/EndCashin préalable (résolu
   * empiriquement le 2026-07-28 — voir docs/open-questions.md). Réf.
   * docs/soap-operations.md, ligne 26 ("ChangeOperation | Encaissement +
   * rendu de monnaie"). Champs requête : WSDL BrueBoxService.wsdl:251-261
   * (ChangeRequestType — Id?, SeqNo, SessionID?, Amount [requis, montant de
   * la vente], Option?, Cash?, ForeignCurrency?).
   *
   * **`Change` attend le dépôt physique du client pendant l'appel HTTP
   * lui-même** — vérifié empiriquement : une réponse a mis 55 secondes à
   * arriver, le temps qu'un billet soit inséré manuellement dans
   * l'émulateur. L'appelant (main.ts, UI) doit prévoir un timeout HTTP long
   * (pas de valeur courte type 10-30s) et une UX "en attente de paiement",
   * pas un simple spinner bref.
   *
   * `Cash`/`Option`/`ForeignCurrency` sont omis en requête (tous optionnels)
   * — ce sprint ne couvre que le cas simple "montant de vente unique,
   * dénominations libres côté client". Codes retour spécifiques : voir
   * docs/error-codes.md (6, 9, 10, 12, 13, 40, 41, 43, 44, 96, 99, 100) —
   * `10` "change shortage" confirmé reproductible si les cassettes de
   * distribution ne peuvent pas rendre la monnaie due.
   */
  async change(sessionId: string, amount: string): Promise<SimpleResult & { cash: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Amount: string },
      { attributes?: Record<string, unknown>; Cash?: unknown }
    >("ChangeOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId, Amount: amount });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), cash: response.Cash };
  }

  /**
   * Démarre un réapprovisionnement par l'entrée (le client dépose des
   * espèces sans transaction de vente, ex. fond de caisse). Réf.
   * docs/soap-operations.md, ligne 40 ("StartReplenishmentFromEntranceOperation
   * | Démarre un réapprovisionnement par l'entrée"). Champs requête : WSDL
   * BrueBoxService.wsdl:1456-1462 (Id?, SeqNo, SessionID?).
   */
  async startReplenishmentFromEntrance(sessionId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("StartReplenishmentFromEntranceOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Termine un réapprovisionnement par l'entrée et restitue les espèces
   * comptées. Réf. docs/soap-operations.md, ligne 41. Champs requête : WSDL
   * BrueBoxService.wsdl:1477-1483 (Id?, SeqNo, SessionID?). Réponse contient
   * `Cash` (détail réel, comme EndCashin — voir sa docstring pour la mise en
   * garde sur `ManualDeposit`, présent aussi ici mais non fiable pour le
   * montant physiquement compté).
   */
  async endReplenishmentFromEntrance(
    sessionId: string
  ): Promise<SimpleResult & { manualDeposit: string | undefined; cash: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown>; ManualDeposit?: string; Cash?: unknown }
    >("EndReplenishmentFromEntranceOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return {
      result,
      resultDescription: describeResultCode(result),
      manualDeposit: response.ManualDeposit,
      cash: response.Cash,
    };
  }

  /**
   * Démarre un réapprovisionnement par cassette : transporte les espèces
   * d'une **cassette I/F (Interface)** vers les stackers de recyclage, et
   * accepte simultanément les pièces déposées à l'entrée. Réf.
   * docs/soap-operations.md, ligne 42. Champs requête : WSDL
   * BrueBoxService.wsdl:1524-1531 (Id?, SeqNo, SessionID?, Option?
   * [RefillOptionType, attribut `type` : 0=Both, 1=Note, 2=Coin — IF Spec
   * p.140]).
   *
   * **Précondition critique (IF Spec p.140) : "This function works only with
   * 'I/F collection cassette'."** — nécessite une cassette de type
   * **Interface** insérée (bouton "IF Cst" du "Change Cassette Operation" de
   * l'émulateur), PAS une cassette "Stack" (celle utilisée pour `Collect` —
   * voir docs/open-questions.md). `deviceType` défaut 0 = "Both".
   */
  async startReplenishmentFromCassette(sessionId: string, deviceType: 0 | 1 | 2 = 0): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("StartReplenishmentFromCassetteOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: deviceType } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Termine un réapprovisionnement par cassette. Réf.
   * docs/soap-operations.md, ligne 43. Champs requête : WSDL
   * BrueBoxService.wsdl:1546-1552 (Id?, SeqNo, SessionID?). Réponse contient
   * `Cash` (requis, contrairement aux autres opérations de ce groupe).
   */
  async endReplenishmentFromCassette(sessionId: string): Promise<SimpleResult & { cash: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown>; Cash?: unknown }
    >("EndReplenishmentFromCassetteOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), cash: response.Cash };
  }

  /**
   * Verrouille physiquement une unité (porte/trappe). Réf.
   * docs/soap-operations.md, ligne 37. Champs requête : WSDL
   * BrueBoxService.wsdl:1576-1583 (Id?, SeqNo, SessionID?, Option [requis,
   * attribut `type` : 1=RBW-100(FrontDoor)/RBW-150(UpperUnit), 2=RCW-100(COFB),
   * 3=RBW-200UL(UpperUnit) — IF Spec p.139]).
   *
   * `unitType` défaut `1` (RBW-100, le modèle ciblé par ce client — voir
   * docs/models.md, CI-10).
   */
  async lockUnit(sessionId: string, unitType: 1 | 2 | 3 = 1): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("LockUnitOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: unitType } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Déverrouille physiquement une unité (porte/trappe), pour retrait manuel.
   * Réf. docs/soap-operations.md, ligne 38. Champs requête : WSDL
   * BrueBoxService.wsdl:1605-1613 (Id?, SeqNo, SessionID?, Option [requis,
   * mêmes valeurs `type` que LockUnit — IF Spec p.137], `Delay` explicitement
   * marqué "Do not use this element" dans le WSDL — jamais envoyé ici).
   */
  async unlockUnit(sessionId: string, unitType: 1 | 2 | 3 = 1): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("UnLockUnitOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: unitType } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Ouvre le couvercle de sortie (retrait de billets catégorie 2/3
   * détectés). Réf. docs/soap-operations.md, ligne 39. Champs requête : WSDL
   * BrueBoxService.wsdl:1635-1641 (Id?, SeqNo, SessionID?).
   */
  async openExitCover(sessionId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("OpenExitCoverOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /** Ferme le couvercle de sortie. Symétrique de `openExitCover`. Réf.
   * docs/soap-operations.md, ligne 39. WSDL BrueBoxService.wsdl:1656-1662. */
  async closeExitCover(sessionId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("CloseExitCoverOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * État des stocks par dénomination. Réf. docs/soap-operations.md, ligne 30
   * ("InventoryOperation | État des stocks par dénomination"). Champs
   * requête : WSDL BrueBoxService.wsdl (InventoryRequestType — Id?, SeqNo,
   * SessionID?, Option [requis, attribut `type` : 0=Tout (défaut, =1+2+3),
   * 1=inventaire dispositif (hors capture bin), 2=nombre de pièces
   * distribuables, 3=nombre de pièces en cassette — IF Spec p.65]).
   */
  async inventory(sessionId: string, scope: 0 | 1 | 2 | 3 = 0): Promise<SimpleResult & { raw: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("InventoryOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: scope } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), raw: response };
  }

  /**
   * Vidage de cassette (collect). Réf. docs/soap-operations.md, ligne 33
   * ("CollectOperation | Vidage cassette"). Champs requête : WSDL
   * BrueBoxService.wsdl:719-732 (CollectRequestType — Id?, SeqNo, SessionID?,
   * Option [requis, attribut `type` : 0=vers cassette, 1=vers fente de
   * sortie (pièces), 2=vers fente de sortie (billets), 3=vers fente de
   * sortie (les deux) — IF Spec p.80], Mix?, IFCassette?,
   * RequireVerification?, Partial?, Cash [requis, attribut `type`=5
   * "Denomination control" dans l'exemple IF Spec p.82], COFBClearOption?).
   *
   * **Aucune valeur "collecter tout" documentée** — voir `CollectDenomination`.
   * L'appelant doit toujours fournir la liste exacte des dénominations et
   * quantités à collecter (`denominations`), comme dans l'exemple IF Spec
   * p.82. `collectionTarget` correspond à `Option.type` (défaut 0 = vers
   * cassette). `Mix`/`IFCassette`/`RequireVerification`/`Partial`/
   * `COFBClearOption` sont omis (tous optionnels, hors périmètre de ce
   * sprint).
   */
  async collect(
    sessionId: string,
    denominations: CollectDenomination[],
    collectionTarget: 0 | 1 | 2 | 3 = 0
  ): Promise<SimpleResult & { cash: unknown }> {
    const response = await this.call<
      {
        SeqNo: string;
        SessionID: string;
        Option: { attributes: { type: number } };
        Cash: {
          attributes: { type: number };
          Denomination: Array<{
            attributes: { cc: string; fv: string; devid: string };
            Piece: number;
            Status: number;
          }>;
        };
      },
      { attributes?: Record<string, unknown>; Cash?: unknown }
    >("CollectOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: collectionTarget } },
      Cash: {
        attributes: { type: 5 },
        Denomination: denominations.map((d) => ({
          attributes: { cc: d.cc, fv: d.fv, devid: d.devid },
          Piece: d.piece,
          Status: 0,
        })),
      },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), cash: response.Cash };
  }

  /**
   * Enregistre un nom d'utilisateur auprès du FCC, **sans authentification**
   * (IF Spec p.98, §3.15 : "There is no authentication function"). N'utilise
   * PAS de SessionID (absent du WSDL pour cette requête — BrueBoxService.wsdl:875-881,
   * LoginUserRequestType : Id?, SeqNo, User). L'IF Spec recommande explicitement
   * `OpenOperation` à la place ("When you use Open Request, it is NOT necessary
   * to use this method") — implémenté ici pour complétude/diagnostic, pas comme
   * mécanisme d'auth principal. L'utilisateur spécial "glory" est explicitement
   * proscrit ("Special User (glory) should not be used").
   */
  async loginUser(userId: string): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; User: string },
      { attributes?: Record<string, unknown> }
    >("LoginUserOperation", { SeqNo: this.nextSeqNo(), User: userId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Déconnecte l'utilisateur courant. Réf. IF Spec p.100, §3.16. Champs
   * requête : WSDL BrueBoxService.wsdl:896-901 (LogoutUserRequestType — Id?,
   * SeqNo seulement, pas de SessionID ni de User).
   */
  async logoutUser(): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string },
      { attributes?: Record<string, unknown> }
    >("LogoutUserOperation", { SeqNo: this.nextSeqNo() });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Récupère les versions firmware du FCC et des unités connectées
   * (RBW-100/RCW-100/etc.). Réf. IF Spec p.100-101, §3.17. Champs requête :
   * WSDL BrueBoxService.wsdl:916-922 (RomVersionRequestType — Id?, SeqNo,
   * SessionID?). Réponse très large (un bloc par type d'unité possible,
   * `RBW10`/`RCW8X`/`RZ50`/.../`RBW100`/`RCW100`/...) — exposée brute (`raw`)
   * plutôt que typée finement, à l'image d'`inventory`, car seuls les blocs
   * correspondant au matériel réellement connecté sont présents en pratique.
   */
  async romVersion(sessionId: string): Promise<SimpleResult & { raw: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("RomVersionOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), raw: response };
  }

  /**
   * Règle la date/heure du FCC et des unités (RBW/RCW). Réf. IF Spec
   * p.135-136, §3.30. Champs requête : WSDL BrueBoxService.wsdl:1419-1429
   * (AdjustTimeRequestType — Id?, SeqNo, SessionID?, Date [requis, attributs
   * `month`/`day`/`year`], Time [requis, attributs `hour`/`minute`/`second`]).
   * Nécessite `Occupy` au préalable (codes retour incluent `3` "occupied by
   * other" et `5` "not occupied", IF Spec p.136).
   */
  async adjustTime(
    sessionId: string,
    date: { month: number; day: number; year: number },
    time: { hour: number; minute: number; second: number }
  ): Promise<SimpleResult> {
    const response = await this.call<
      {
        SeqNo: string;
        SessionID: string;
        Date: { attributes: { month: number; day: number; year: number } };
        Time: { attributes: { hour: number; minute: number; second: number } };
      },
      { attributes?: Record<string, unknown> }
    >("AdjustTimeOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Date: { attributes: date },
      Time: { attributes: time },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Récupère le contenu XML d'un fichier de configuration du FCC (ex.
   * "GloryCo.xml", "FunctionSetting.xml" — noms observés empiriquement via
   * SSH sur la VM, voir docs/development-notes.md). Réf. IF Spec p.176,
   * §3.48. Champs requête : WSDL BrueBoxService.wsdl:2044-2051
   * (GetSettingFileRequestType — Id?, SeqNo, SessionID?, FileName [requis]).
   * Réponse contient `SettingFile` (chaîne XML brute, WSDL:2054-2063).
   */
  async getSettingFile(sessionId: string, fileName: string): Promise<SimpleResult & { settingFile: string | undefined }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; FileName: string },
      { attributes?: Record<string, unknown>; SettingFile?: string }
    >("GetSettingFileOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId, FileName: fileName });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), settingFile: response.SettingFile };
  }

  /**
   * Annule un cycle d'encaissement en cours. Réf. IF Spec p.58-61, §3.6
   * "Cancel Cash in Request" — distincte d'`endCashin` (clôture normale) et
   * volontairement **non appelée automatiquement** par ce client dans un
   * scénario d'erreur : testée empiriquement le 2026-07-29 (voir
   * docs/open-questions.md, scénario "billet catégorie 2/3") — **bloque
   * indéfiniment le simulateur si le device est dans un état d'erreur
   * cat.2/3**, exactement comme `endCashin`. À utiliser uniquement en cours
   * normal de transaction (le WSDL/IF Spec ne documente aucune précaution
   * particulière hors de ce cas déjà rencontré). Champs requête : WSDL
   * BrueBoxService.wsdl:469-475 (Id?, SeqNo, SessionID?). Réponse contient
   * `Cash` (toujours 2 éléments : `type=1` dépôt, `type=2` remboursement —
   * IF Spec p.59-60) et `ManualDeposit`/`DepositCurrency` (mêmes réserves que
   * `endCashin` sur `ManualDeposit`, voir sa docstring).
   */
  async cashinCancel(
    sessionId: string
  ): Promise<SimpleResult & { manualDeposit: string | undefined; cash: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown>; ManualDeposit?: string; Cash?: unknown }
    >("CashinCancelOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return {
      result,
      resultDescription: describeResultCode(result),
      manualDeposit: response.ManualDeposit,
      cash: response.Cash,
    };
  }

  /**
   * Annule une transaction `Change` en cours d'attente de rendu de monnaie.
   * Réf. IF Spec p.49-51, §3.3 "Change Cancel Request" : "Cancelled change
   * transaction by ChangeCancelRequest is finished by responding the
   * result=1 in change response (Not cancel response)" — **c'est l'appel
   * `Change` bloquant en cours (voir docstring `change`) qui se termine avec
   * `result=1`, pas cette réponse `ChangeCancel` elle-même**. Doit donc être
   * appelé depuis une session/connexion distincte de celle qui attend dans
   * `Change`. Uniquement valide en état "Waiting Cancellation" (Status.Code
   * `23`). Champs requête : WSDL BrueBoxService.wsdl:284-291
   * (ChangeCancelRequestType — Id?, SeqNo, SessionID?, Option? [attribut
   * `type` : 0=exécute l'annulation, 1=sort avec erreur `10` "change
   * shortage"]). `cancelType` défaut `0`.
   */
  async changeCancel(sessionId: string, cancelType: 0 | 1 = 0): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("ChangeCancelOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: cancelType } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Annule un réapprovisionnement par l'entrée en cours. Réf. IF Spec
   * p.155-157, §3.39. "Except the device is in the middle of the cash in
   * transaction, returns exclusive error (result=11)." Champs requête :
   * WSDL BrueBoxService.wsdl:1500-1506 (Id?, SeqNo, SessionID?). Réponse
   * contient `Cash` (2 éléments, mêmes conventions type=1/2 que
   * `cashinCancel`) et `ManualDeposit`/`DepositCurrency`.
   */
  async replenishmentFromEntranceCancel(
    sessionId: string
  ): Promise<SimpleResult & { manualDeposit: string | undefined; cash: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown>; ManualDeposit?: string; Cash?: unknown }
    >("ReplenishmentFromEntranceCancelOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return {
      result,
      resultDescription: describeResultCode(result),
      manualDeposit: response.ManualDeposit,
      cash: response.Cash,
    };
  }

  /**
   * Distribue des espèces pour des dénominations précises, sans transaction
   * de vente (ex. paiement d'appoint, remboursement manuel). Réf. IF Spec
   * p.61-63, §3.7 "Cash out Request" : "The device conduct cash out
   * transaction of assigned denomination information... Not able to cancel
   * cash out transaction." Champs requête : WSDL BrueBoxService.wsdl:356-364
   * (CashoutRequestType — Id?, SeqNo, SessionID?, Delay? [optionnel, non
   * exposé ici — dispense différée par intervalle, hors périmètre de ce
   * sprint], Cash [requis, `type="2"` "Cash out information", même
   * convention que `CollectDenomination`]).
   *
   * **Aucune annulation possible une fois lancé** — contrairement à
   * `collect`, ne jamais appeler en boucle de retry automatique sans
   * confirmation explicite de l'appelant.
   */
  async cashout(sessionId: string, denominations: CollectDenomination[]): Promise<SimpleResult & { cash: unknown }> {
    const response = await this.call<
      {
        SeqNo: string;
        SessionID: string;
        Cash: {
          attributes: { type: number };
          Denomination: Array<{ attributes: { cc: string; fv: string; devid: string }; Piece: number; Status: number }>;
        };
      },
      { attributes?: Record<string, unknown>; Cash?: unknown }
    >("CashoutOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Cash: {
        attributes: { type: 2 },
        Denomination: denominations.map((d) => ({
          attributes: { cc: d.cc, fv: d.fv, devid: d.devid },
          Piece: d.piece,
          Status: 0,
        })),
      },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), cash: response.Cash };
  }

  /**
   * Renvoie les pièces restantes dans le hopper vers la fente de sortie
   * ("ReturnCoin" — le nom WSDL `ReturnCash` est plus large mais l'IF Spec
   * §3.26 ne documente que ce cas). Réf. IF Spec p.126-128 : "Return
   * remaining coins in the hopper to the exit slot." Champs requête : WSDL
   * BrueBoxService.wsdl:1309-1316 (Id?, SeqNo, SessionID?, Option [requis,
   * attribut `type` : `0`/`1` explicitement marqués **"unused"** dans l'IF
   * Spec, `2`=Coin — seule valeur documentée comme active]). `deviceType`
   * défaut `2` (Coin, seule option confirmée fonctionnelle).
   */
  async returnCash(sessionId: string, deviceType: 0 | 1 | 2 = 2): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Option: { attributes: { type: number } } },
      { attributes?: Record<string, unknown> }
    >("ReturnCashOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Option: { attributes: { type: deviceType } },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Réinitialise l'appareil — récupération d'erreur générale. Réf. IF Spec
   * p.86-87, §3.10 : "Requests reset of the device. If the CI-10(ISP-K05) is
   * in the middle of cash in transaction, cancels cash in transaction then
   * have the reset." Champs requête : WSDL BrueBoxService.wsdl:405-411
   * (ResetRequestType — Id?, SeqNo, SessionID?). Réponse contient `Status`
   * (même structure que `getStatus`).
   *
   * **Mise en garde empirique (2026-07-29, voir docs/open-questions.md,
   * scénario "billet catégorie 2/3")** : normalement rapide (observé
   * jusqu'à ~24s dans le pire cas connu), mais peut rester bloqué
   * indéfiniment si l'appareil est dans un état d'erreur que le simulateur
   * ne sait pas nettoyer (ex. billet catégorie 2/3 non retiré). L'appelant
   * DOIT prévoir un timeout et une voie d'escalade (ne pas attendre
   * indéfiniment une réponse HTTP qui peut ne jamais arriver).
   */
  async reset(sessionId: string): Promise<SimpleResult & { raw: unknown }> {
    const response = await this.call<
      { SeqNo: string; SessionID: string },
      { attributes?: Record<string, unknown> }
    >("ResetOperation", { SeqNo: this.nextSeqNo(), SessionID: sessionId });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result), raw: response };
  }

  /**
   * Ré-autorise l'acceptation d'une dénomination précédemment interdite (ex.
   * après une restriction pour pénurie de monnaie). Réf. IF Spec p.128-130,
   * §3.27 "Permit Denomination Request". Champs requête : WSDL
   * BrueBoxService.wsdl:1338-1345 (EnableDenomRequestType — Id?, SeqNo,
   * SessionID?, Cash [requis, CashType]). Exemple IF Spec : `Cash type="5"`
   * (Denomination control), `Denomination` avec attributs `cc`/`fv`/`devid`,
   * `Piece` et `Status` tous deux fixés à `0` dans l'exemple ("0 fix").
   * Nécessite Occupy (codes `3`/`5`).
   */
  async enableDenom(sessionId: string, denominations: CollectDenomination[]): Promise<SimpleResult> {
    const response = await this.call<
      {
        SeqNo: string;
        SessionID: string;
        Cash: {
          attributes: { type: number };
          Denomination: Array<{ attributes: { cc: string; fv: string; devid: string }; Piece: number; Status: number }>;
        };
      },
      { attributes?: Record<string, unknown> }
    >("EnableDenomOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Cash: {
        attributes: { type: 5 },
        Denomination: denominations.map((d) => ({
          attributes: { cc: d.cc, fv: d.fv, devid: d.devid },
          Piece: 0,
          Status: 0,
        })),
      },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /** Interdit l'acceptation d'une dénomination (restriction temporaire, ex.
   * pénurie de monnaie pour le rendu). Symétrique de `enableDenom`. Réf.
   * IF Spec p.130-132, §3.28 "Prohibit denomination Request". WSDL
   * BrueBoxService.wsdl:1360-1367. Mêmes conventions de requête que
   * `enableDenom` (`Cash type="5"`, `Piece`/`Status` fixés à `0`). */
  async disableDenom(sessionId: string, denominations: CollectDenomination[]): Promise<SimpleResult> {
    const response = await this.call<
      {
        SeqNo: string;
        SessionID: string;
        Cash: {
          attributes: { type: number };
          Denomination: Array<{ attributes: { cc: string; fv: string; devid: string }; Piece: number; Status: number }>;
        };
      },
      { attributes?: Record<string, unknown> }
    >("DisableDenomOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Cash: {
        attributes: { type: 5 },
        Denomination: denominations.map((d) => ({
          attributes: { cc: d.cc, fv: d.fv, devid: d.devid },
          Piece: 0,
          Status: 0,
        })),
      },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Définit le taux de change entre une devise étrangère et la devise
   * principale. **Persisté dans le fichier de configuration** — "The
   * specified rate is saved in the configuration file, it is used as the
   * default" (IF Spec p.158, §3.40). Champs requête : WSDL
   * BrueBoxService.wsdl:1702-1709 (SetExchangeRateRequestType — Id?, SeqNo,
   * SessionID?, ExchangeRateSetting [requis, liste `ExchangeRate` avec
   * attributs `from`/`to` requis (codes devise, ex. "USD"→"EUR") + élément
   * `Rate` (chaîne décimale, ex. "0.76951")]).
   */
  async setExchangeRate(sessionId: string, rates: Array<{ from: string; to: string; rate: string }>): Promise<SimpleResult> {
    const response = await this.call<
      {
        SeqNo: string;
        SessionID: string;
        ExchangeRateSetting: { ExchangeRate: Array<{ attributes: { from: string; to: string }; Rate: string }> };
      },
      { attributes?: Record<string, unknown> }
    >("SetExchangeRateOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      ExchangeRateSetting: {
        ExchangeRate: rates.map((r) => ({ attributes: { from: r.from, to: r.to }, Rate: r.rate })),
      },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }

  /**
   * Restreint l'accès à des stackers spécifiques (les stackers listés
   * deviennent restreints, les autres sont libérés). **Réservé à
   * RBW-200/RBG-200** — "This command is valid only for RBG-200 and
   * RBW-200" (IF Spec p.160, §3.41). **Sans objet sur ce client (modèle
   * CI-10/RBW-100/RCW-100, voir docs/models.md)** : implémenté pour
   * complétude d'API, mais un appel réel contre la VM RBW-100 n'a pas de
   * matériel cible documenté — comportement (résultat/no-op) non vérifié
   * empiriquement, voir docs/open-questions.md. Champs requête : WSDL
   * BrueBoxService.wsdl:1799-1808 (SetRestrictionRequestType — Id?, SeqNo,
   * SessionID?, Restrictions [requis, liste `Restriction` avec attribut
   * `stacker` requis]).
   */
  async setRestriction(sessionId: string, stackers: number[]): Promise<SimpleResult> {
    const response = await this.call<
      { SeqNo: string; SessionID: string; Restrictions: { Restriction: Array<{ attributes: { stacker: number } }> } },
      { attributes?: Record<string, unknown> }
    >("SetRestrictionOperation", {
      SeqNo: this.nextSeqNo(),
      SessionID: sessionId,
      Restrictions: { Restriction: stackers.map((s) => ({ attributes: { stacker: s } })) },
    });
    const result = extractResultAttribute(response);
    return { result, resultDescription: describeResultCode(result) };
  }
}
