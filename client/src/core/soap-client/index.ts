import * as soap from "soap";
import axios from "axios";
import * as https from "https";
import * as path from "path";
import { describeResultCode } from "./result-codes";

/** Chemin vers la copie racine de BrueBoxService.wsdl, la seule à utiliser —
 * voir docs/development-notes.md, "Piège n°1" (plusieurs copies incomplètes
 * du WSDL existent ailleurs dans le SDK, toujours préférer celle-ci). */
const WSDL_PATH = path.resolve(__dirname, "../../../../BrueBoxService.wsdl");

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
}
