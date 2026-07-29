import * as net from "net";

/**
 * Écouteur d'événements FCC, dans le processus main Electron (jamais dans le
 * renderer — accès direct aux sockets réseau). Les deux mécanismes officiels
 * documentés dans docs/event-system.md sont représentés ici :
 *
 * - "tcp" : socket TCP brut, tel qu'illustré par App/PosSimple. Implémenté
 *   dans ce sprint (Étape 3) : log brut des trames reçues, sans parsing.
 * - "soap-callback" : callback SOAP via EventService.wsdl (BbxEventOperation).
 *   NON implémenté dans ce sprint — la consigne du sprint (Étape 3) ne demande
 *   que la validation du canal TCP. Sélectionner ce mode lève une erreur
 *   explicite plutôt qu'un comportement silencieusement absent (voir
 *   `start()` ci-dessous).
 */
export type EventListenerMode = "tcp" | "soap-callback";

export type RawEventLogger = (source: string, rawData: string) => void;

export interface EventListenerConfig {
  mode: EventListenerMode;
  tcpPort: number;
  logger: RawEventLogger;
}

export class EventListener {
  private server: net.Server | null = null;
  private readonly config: EventListenerConfig;

  constructor(config: EventListenerConfig) {
    this.config = config;
  }

  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  async start(): Promise<void> {
    if (this.config.mode === "soap-callback") {
      throw new Error(
        "Mode 'soap-callback' non implémenté (seul le canal TCP brut est couvert, " +
          "voir docs/event-system.md). Sélectionner 'tcp'."
      );
    }
    if (this.server) {
      throw new Error("EventListener déjà démarré.");
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const peer = `${socket.remoteAddress}:${socket.remotePort}`;
        this.config.logger(peer, `[connexion ouverte]`);
        socket.on("data", (chunk) => {
          // Aucun parsing fin à ce stade — objectif du sprint : prouver que
          // les événements arrivent (consigne Étape 3). Affichage brut en
          // UTF-8 et en hexadécimal pour ne rien perdre si le format n'est
          // pas du texte pur (docs/event-system.md ne documente pas le
          // format exact des trames TCP — non deviné ici).
          const utf8 = chunk.toString("utf8").replace(/\0/g, "\\0");
          const hex = chunk.toString("hex");
          this.config.logger(peer, `utf8="${utf8}" hex=${hex}`);
        });
        socket.on("close", () => {
          this.config.logger(peer, `[connexion fermée]`);
        });
        socket.on("error", (err) => {
          this.config.logger(peer, `[erreur socket] ${err.message}`);
        });
      });
      server.on("error", reject);
      server.listen(this.config.tcpPort, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
