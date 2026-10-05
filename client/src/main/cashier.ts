import { FccSoapClient, SimpleResult, CollectDenomination } from "../core/soap-client";
import { EventListener } from "../core/event-listener";
import { HistoryStore } from "../core/history-store";
import { Ledger, TransactionKind } from "../core/ledger";
import { FccConnectionConfig } from "../core/fcc-config";
import { FrameSplitter, parseFrame, FccEvent } from "../core/fcc-events";
import {
  CashType,
  DenomLine,
  InventorySnapshot,
  linesOfType,
  parseInventory,
  planCollectKeepFloat,
  planPayout,
  receivedLines,
  totalCents,
} from "../core/cash";

const DEVICE_NAME = "glory-fcc-client";

/** Message compréhensible par un commerçant ; le détail technique reste dans le journal. */
function friendlyNetworkError(raw: string, cfg: FccConnectionConfig): string {
  if (/EADDRINUSE/.test(raw)) return `Le port ${cfg.eventTcpPort} est déjà utilisé sur ce PC (l'application est peut-être ouverte deux fois).`;
  if (/EACCES/.test(raw)) return `Windows refuse l'ouverture du port ${cfg.eventTcpPort} : choisissez un autre port dans Réglages.`;
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|timeout/i.test(raw)) {
    return "Le terminal ne répond pas. Vérifiez qu'il est allumé, branché au réseau, et que son adresse est correcte dans Réglages.";
  }
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) return "Le certificat HTTPS du terminal est refusé : décochez « Exiger un certificat HTTPS valide » dans Réglages, ou utilisez http://.";
  if (/404|Not Found/i.test(raw)) return "L'adresse du terminal est joignable mais incorrecte (vérifiez la fin : /axis2/services/BrueBoxService).";
  return `Connexion impossible : ${raw}`;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface OpResult {
  ok: boolean;
  message: string;
  /** Code résultat FCC brut quand il existe. */
  result?: number;
}

export interface MoneyResult extends OpResult {
  dueCents?: number;
  inCents: number;
  outCents: number;
  inLines: DenomLine[];
  outLines: DenomLine[];
  transactionId?: number;
}

export interface CashierHooks {
  log(line: string): void;
  event(e: FccEvent): void;
  state(s: { connection: ConnectionState; sessionMode: boolean; occupyMode: boolean; busy: string | null }): void;
}

/**
 * Point d'entrée unique vers le terminal. Remplace la trentaine de
 * fonctions quasi identiques de l'ancien main.ts : chaque opération passe
 * par `run()` (vérif connexion, une seule opération à la fois, journal,
 * gestion d'erreur), et chaque mouvement d'espèces est inscrit au journal
 * métier (`Ledger`).
 */
export class Cashier {
  private client: FccSoapClient | null = null;
  private listener: EventListener | null = null;
  private splitter = new FrameSplitter();
  private sessionId: string | undefined;
  private sessionMode = false;
  private occupyMode = false;
  private eventRegistered = false;
  private callback: { ip: string; port: number } | null = null;
  private busy: string | null = null;
  private connection: ConnectionState = "disconnected";
  user = "";

  constructor(
    private readonly hooks: CashierHooks,
    private readonly history: HistoryStore,
    private readonly ledger: Ledger
  ) {}

  isConnected(): boolean {
    return this.connection === "connected";
  }

  private emitState(): void {
    this.hooks.state({
      connection: this.connection,
      sessionMode: this.sessionMode,
      occupyMode: this.occupyMode,
      busy: this.busy,
    });
  }

  private log(line: string): void {
    this.hooks.log(line);
  }

  private fail(message: string, result?: number): OpResult {
    this.log(`[ERREUR] ${message}`);
    return { ok: false, message, result };
  }

  /**
   * Exécute une opération terminal. `exclusive=false` pour les commandes qui
   * doivent pouvoir partir pendant une autre (annulation d'un Change en
   * attente, statut).
   */
  private async run<T extends OpResult>(label: string, fn: (c: FccSoapClient, sid: string) => Promise<T>, exclusive = true): Promise<T | OpResult> {
    if (!this.client || this.sessionId === undefined || this.connection !== "connected") {
      return { ok: false, message: "Terminal non connecté." };
    }
    if (exclusive && this.busy) {
      return { ok: false, message: `Opération en cours : ${this.busy}. Patientez ou annulez-la.` };
    }
    if (exclusive) {
      this.busy = label;
      this.emitState();
    }
    try {
      return await fn(this.client, this.sessionId);
    } catch (err) {
      return this.fail(`${label} : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (exclusive) {
        this.busy = null;
        this.emitState();
      }
    }
  }

  private simple(label: string, r: SimpleResult): OpResult {
    this.log(`${label} → ${r.resultDescription}`);
    return { ok: r.result === 0, message: r.result === 0 ? `${label} : OK` : `${label} : ${r.resultDescription}`, result: r.result };
  }

  private record(kind: TransactionKind, r: MoneyResult, extra: { dueCents?: number; note?: string } = {}): number {
    return this.ledger.add({
      kind,
      user: this.user,
      dueCents: extra.dueCents ?? null,
      inCents: r.inCents,
      outCents: r.outCents,
      ok: r.ok,
      result: r.result ?? null,
      inLines: r.inLines,
      outLines: r.outLines,
      note: extra.note ?? r.message,
    });
  }

  private money(label: string, r: SimpleResult & { cash?: unknown }, okCodes: number[] = [0], withIn = true): MoneyResult {
    // Les sorties (cashout, collecte) n'ont pas d'espèces reçues : ne pas
    // réinterpréter leurs blocs Cash comme un dépôt.
    const inLines = withIn ? receivedLines(r.cash) : [];
    const outLines = linesOfType(r.cash, CashType.CashOut);
    const ok = okCodes.includes(r.result);
    this.log(`${label} → ${r.resultDescription}`);
    return {
      ok,
      result: r.result,
      message: ok ? `${label} : OK` : `${label} : ${r.resultDescription}`,
      inLines,
      outLines,
      inCents: totalCents(inLines),
      outCents: totalCents(outLines),
    };
  }

  // ---------------------------------------------------------------- connexion

  async connect(cfg: FccConnectionConfig, eventMode: "tcp" | "soap-callback"): Promise<OpResult> {
    if (this.connection !== "disconnected") return { ok: false, message: "Déjà connecté ou connexion en cours." };
    this.connection = "connecting";
    this.emitState();
    try {
      this.splitter = new FrameSplitter();
      this.listener = new EventListener({
        mode: eventMode,
        tcpPort: cfg.eventTcpPort,
        logger: (source, raw, text) => {
          this.history.record("raw-tcp-event", source, raw);
          if (text === undefined) return;
          for (const frame of this.splitter.push(text)) {
            const e = parseFrame(frame);
            if (e.kind !== "heartbeat") this.log(`[ÉVÉNEMENT] ${JSON.stringify(e)}`);
            this.hooks.event(e);
          }
        },
      });
      await this.listener.start();
      this.log(`Écouteur d'événements démarré sur le port ${cfg.eventTcpPort}.`);

      this.client = await FccSoapClient.create({
        endpoint: cfg.soapEndpoint,
        rejectUnauthorized: cfg.rejectUnauthorized,
        logger: (direction, operation, payload) => {
          this.log(`[SOAP ${direction === "request" ? "→" : "←"}] ${operation} ${JSON.stringify(payload)}`);
          this.history.record(direction === "request" ? "soap-request" : "soap-response", operation, payload);
        },
      });

      // Session mode / Occupy mode sont des réglages du terminal (Web
      // setting → App Configuration). 20 = mode session désactivé, 4 = mode
      // Occupy désactivé (défaut) — voir docs/development-notes.md.
      const open = await this.client.open(cfg.userId, cfg.userPwd, DEVICE_NAME);
      this.log(`Open → ${open.resultDescription}`);
      if (open.result === 0 && open.sessionId) {
        this.sessionId = open.sessionId;
        this.sessionMode = true;
      } else if (open.result === 20) {
        this.sessionId = "";
        this.sessionMode = false;
        this.log("Mode session désactivé sur le terminal — fonctionnement sans session.");
      } else {
        await this.teardown();
        return this.fail(
          open.result === 15
            ? "Identifiant ou mot de passe refusé par le terminal (Réglages → Connexion)."
            : open.result === 16
              ? "Trop de sessions ouvertes sur le terminal — réessayez dans quelques minutes."
              : `Ouverture refusée par le terminal : ${open.resultDescription}`,
          open.result
        );
      }

      this.callback = { ip: cfg.callbackIp, port: cfg.eventTcpPort };
      const reg = await this.client.registerEvent({ sessionId: this.sessionId, url: cfg.callbackIp, port: cfg.eventTcpPort });
      this.eventRegistered = reg.result === 0;
      this.log(`RegisterEvent → ${reg.resultDescription}`);
      if (!this.eventRegistered) this.log("[ERREUR] Le terminal a refusé l'abonnement aux événements : pas d'affichage en direct.");

      const occ = await this.client.occupy(this.sessionId);
      this.log(`Occupy → ${occ.resultDescription}`);
      if (occ.result === 0 || occ.result === 17) {
        this.occupyMode = true;
      } else if (occ.result === 4) {
        this.occupyMode = false;
      } else {
        await this.teardown();
        return this.fail(
          occ.result === 3 ? "Le terminal est occupé par une autre caisse." : `Réservation du terminal refusée : ${occ.resultDescription}`,
          occ.result
        );
      }

      this.connection = "connected";
      this.emitState();
      this.history.record("state-transition", null, { state: "connected", sessionMode: this.sessionMode, occupyMode: this.occupyMode });
      return { ok: true, message: "Terminal connecté." };
    } catch (err) {
      await this.teardown();
      const raw = err instanceof Error ? err.message : String(err);
      this.log(`[ERREUR] Connexion : ${raw}`);
      return { ok: false, message: friendlyNetworkError(raw, cfg) };
    }
  }

  /** Déconnexion : chaque étape est tentée, l'état local est toujours remis à zéro. */
  async disconnect(): Promise<OpResult> {
    if (this.connection === "disconnected") return { ok: false, message: "Non connecté." };
    const ok = await this.teardown();
    return { ok, message: ok ? "Terminal déconnecté." : "Déconnecté (certaines étapes ont échoué, voir le journal)." };
  }

  private async teardown(): Promise<boolean> {
    let allOk = true;
    const c = this.client;
    const sid = this.sessionId;
    const step = async (label: string, fn: () => Promise<SimpleResult>) => {
      try {
        const r = await fn();
        this.log(`${label} → ${r.resultDescription}`);
        if (r.result !== 0) allOk = false;
      } catch (err) {
        allOk = false;
        this.log(`[ERREUR] ${label} : ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (c && sid !== undefined) {
      if (this.occupyMode) await step("Release", () => c.release(sid));
      if (this.eventRegistered && this.callback) {
        const cb = this.callback;
        await step("UnRegisterEvent", () => c.unRegisterEvent({ sessionId: sid, url: cb.ip, port: cb.port }));
      }
      if (this.sessionMode && sid) await step("Close", () => c.close(sid));
    }
    try {
      await this.listener?.stop();
    } catch (err) {
      this.log(`[ERREUR] Arrêt de l'écouteur : ${err instanceof Error ? err.message : String(err)}`);
    }
    this.client = null;
    this.listener = null;
    this.sessionId = undefined;
    this.sessionMode = false;
    this.occupyMode = false;
    this.eventRegistered = false;
    this.callback = null;
    this.busy = null;
    this.connection = "disconnected";
    this.emitState();
    this.history.record("state-transition", null, { state: "disconnected" });
    return allOk;
  }

  // ------------------------------------------------------------- consultation

  async status(): Promise<OpResult & { raw?: unknown; code?: number }> {
    return this.run(
      "Statut",
      async (c, sid) => {
        const r = await c.getStatus(sid);
        const status = (r.raw as Record<string, unknown> | undefined)?.Status as Record<string, unknown> | undefined;
        return { ...this.simple("Statut", r), raw: r.raw, code: Number(status?.Code ?? -1) };
      },
      false
    );
  }

  async inventory(): Promise<OpResult & { inventory?: InventorySnapshot }> {
    return this.run(
      "Inventaire",
      async (c, sid) => {
        const r = await c.inventory(sid, 0);
        this.history.record("soap-response", "InventoryOperation", r);
        return { ...this.simple("Inventaire", r), inventory: parseInventory(r.raw) };
      },
      false
    );
  }

  // ------------------------------------------------------------------ ventes

  /** Vente avec rendu de monnaie : bloque jusqu'au paiement complet ou à l'annulation. */
  async sale(amountCents: number): Promise<MoneyResult | OpResult> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, message: "Montant invalide." };
    return this.run("Vente", async (c, sid) => {
      const r = await c.change(sid, String(amountCents));
      // 1 = annulé à la demande (ChangeCancel) : les espèces sont rendues.
      const res = this.money("Vente", r);
      if (r.result === 1) res.message = "Vente annulée — espèces rendues au client.";
      if (r.result === 10) res.message = "Monnaie insuffisante pour rendre — vente annulée, espèces rendues.";
      res.dueCents = amountCents;
      res.transactionId = this.record(r.result === 0 ? "sale" : "cancel", res, { dueCents: amountCents });
      return res;
    });
  }

  /** Annule la vente en attente (envoyé pendant que `sale()` attend le client). */
  async cancelSale(): Promise<OpResult> {
    return this.run("Annulation vente", async (c, sid) => this.simple("Annulation vente", await c.changeCancel(sid, 0)), false);
  }

  /** Dépôt libre (sans montant attendu) : start puis end. */
  async depositStart(): Promise<OpResult> {
    return this.run("Dépôt", async (c, sid) => this.simple("Début de dépôt", await c.startCashin(sid, 0)));
  }

  async depositEnd(): Promise<MoneyResult | OpResult> {
    return this.run("Dépôt", async (c, sid) => {
      const r = this.money("Fin de dépôt", await c.endCashin(sid));
      r.transactionId = this.record("deposit", r);
      return r;
    });
  }

  async depositCancel(): Promise<MoneyResult | OpResult> {
    return this.run("Annulation dépôt", async (c, sid) => {
      const r = this.money("Annulation du dépôt", await c.cashinCancel(sid), [0]);
      if (r.ok) r.transactionId = this.record("cancel", r, { note: "Dépôt annulé" });
      return r;
    }, false);
  }

  /** Sortie d'un montant (remboursement, paiement fournisseur...). */
  async payout(amountCents: number, reason: string): Promise<MoneyResult | OpResult> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, message: "Montant invalide." };
    return this.run("Sortie d'espèces", async (c, sid) => {
      const inv = parseInventory((await c.inventory(sid, 0)).raw);
      const plan = planPayout(amountCents, inv.dispensable);
      if (!plan) return { ok: false, message: "Impossible de rendre ce montant exact avec les espèces disponibles." };
      const r = this.money("Sortie d'espèces", await c.cashout(sid, plan.map((l) => ({ ...l }))), [0], false);
      if (r.ok && r.outLines.length === 0) {
        r.outLines = plan;
        r.outCents = totalCents(plan);
      }
      r.transactionId = this.record("payout", r, { dueCents: amountCents, note: reason });
      return r;
    });
  }

  // -------------------------------------------------------- réapprovisionnement

  async refillStart(): Promise<OpResult> {
    return this.run("Réapprovisionnement", async (c, sid) => this.simple("Début du réapprovisionnement", await c.startReplenishmentFromEntrance(sid)));
  }

  async refillEnd(): Promise<MoneyResult | OpResult> {
    return this.run("Réapprovisionnement", async (c, sid) => {
      const r = this.money("Fin du réapprovisionnement", await c.endReplenishmentFromEntrance(sid));
      r.transactionId = this.record("refill", r);
      return r;
    });
  }

  async refillCancel(): Promise<MoneyResult | OpResult> {
    return this.run("Annulation réapprovisionnement", async (c, sid) => {
      const r = this.money("Annulation du réapprovisionnement", await c.replenishmentFromEntranceCancel(sid));
      return r;
    }, false);
  }

  // ------------------------------------------------------------------ collecte

  async collectPlan(mode: "all" | "float", floatCents = 0): Promise<OpResult & { plan?: DenomLine[] }> {
    return this.run(
      "Préparation collecte",
      async (c, sid) => {
        const inv = parseInventory((await c.inventory(sid, 0)).raw);
        const plan = mode === "all" ? inv.dispensable : planCollectKeepFloat(inv.dispensable, floatCents);
        return { ok: true, message: "OK", plan };
      },
      false
    );
  }

  async collect(lines: DenomLine[]): Promise<MoneyResult | OpResult> {
    const list: CollectDenomination[] = lines.filter((l) => l.piece > 0).map((l) => ({ ...l }));
    if (list.length === 0) return { ok: false, message: "Rien à collecter." };
    return this.run("Collecte", async (c, sid) => {
      const raw = await c.collect(sid, list, 0);
      const r = this.money("Collecte", raw, [0], false);
      // La collecte sort des stackers : on journalise ce qui a été demandé
      // si le terminal ne renvoie pas le détail.
      if (r.ok && r.outLines.length === 0) {
        r.outLines = list.map((l) => ({ ...l }));
        r.outCents = totalCents(r.outLines);
      }
      r.transactionId = this.record("collect", r);
      return r;
    });
  }

  // -------------------------------------------------------------------- échange

  async exchangeStart(): Promise<OpResult> {
    return this.depositStart();
  }

  /** Fin du dépôt de l'échange : renvoie ce qui a été reçu, sans encore rendre. */
  async exchangeReceived(): Promise<MoneyResult | OpResult> {
    return this.run("Échange", async (c, sid) => this.money("Échange — dépôt", await c.endCashin(sid)));
  }

  async exchangeGive(receivedCents: number, depositLines: DenomLine[], give: DenomLine[]): Promise<MoneyResult | OpResult> {
    if (totalCents(give) !== receivedCents) return { ok: false, message: "Le montant rendu doit être égal au montant déposé." };
    return this.run("Échange", async (c, sid) => {
      const r = this.money("Échange — rendu", await c.cashout(sid, give.map((l) => ({ ...l }))), [0], false);
      if (r.ok && r.outLines.length === 0) {
        r.outLines = give;
        r.outCents = totalCents(give);
      }
      r.inLines = depositLines;
      r.inCents = receivedCents;
      r.transactionId = this.record("exchange", r);
      return r;
    });
  }

  // --------------------------------------------------------------- administration

  reset(): Promise<OpResult> {
    return this.run("Réinitialisation", async (c, sid) => {
      const r = await Promise.race([
        c.reset(sid),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pas de réponse après 60 s")), 60_000)),
      ]);
      return this.simple("Réinitialisation", r);
    });
  }

  reboot(): Promise<OpResult> {
    return this.run("Redémarrage", async (c, sid) => this.simple("Redémarrage du terminal", await c.powerControl(sid, 1)));
  }

  shutdown(): Promise<OpResult> {
    return this.run("Arrêt", async (c, sid) => this.simple("Arrêt du terminal", await c.powerControl(sid, 0)));
  }

  /** unit : 1 = billets (RBW), 2 = pièces (RCW, COFB). */
  unlock(unit: 1 | 2): Promise<OpResult> {
    const label = unit === 1 ? "Déverrouillage billets" : "Déverrouillage pièces";
    return this.run(label, async (c, sid) => this.simple(label, await c.unlockUnit(sid, unit)));
  }

  lock(unit: 1 | 2): Promise<OpResult> {
    const label = unit === 1 ? "Verrouillage billets" : "Verrouillage pièces";
    return this.run(label, async (c, sid) => this.simple(label, await c.lockUnit(sid, unit)));
  }

  openCover(): Promise<OpResult> {
    return this.run("Couvercle", async (c, sid) => this.simple("Ouverture du couvercle", await c.openExitCover(sid)));
  }

  closeCover(): Promise<OpResult> {
    return this.run("Couvercle", async (c, sid) => this.simple("Fermeture du couvercle", await c.closeExitCover(sid)));
  }

  returnCoins(): Promise<OpResult> {
    return this.run("Restitution pièces", async (c, sid) => this.simple("Restitution des pièces", await c.returnCash(sid, 2)));
  }

  syncTime(): Promise<OpResult> {
    return this.run("Heure", async (c, sid) => {
      const n = new Date();
      return this.simple(
        "Mise à l'heure",
        await c.adjustTime(sid, { month: n.getMonth() + 1, day: n.getDate(), year: n.getFullYear() }, { hour: n.getHours(), minute: n.getMinutes(), second: n.getSeconds() })
      );
    });
  }

  // --------------------------------------------------------------- outils techniques

  async firmware(): Promise<OpResult & { raw?: unknown }> {
    return this.run("Versions", async (c, sid) => {
      const r = await c.romVersion(sid);
      return { ...this.simple("Versions firmware", r), raw: r.raw };
    }, false);
  }

  async settingFile(name: string): Promise<OpResult & { raw?: unknown }> {
    return this.run("Fichier config", async (c, sid) => {
      const r = await c.getSettingFile(sid, name);
      return { ...this.simple("Lecture du fichier de configuration", r), raw: r.settingFile };
    }, false);
  }

  setDenomination(cc: string, fv: string, devid: string, enabled: boolean): Promise<OpResult> {
    const d = [{ cc, fv, devid, piece: 0 }];
    return this.run("Dénomination", async (c, sid) =>
      this.simple(enabled ? "Autorisation dénomination" : "Interdiction dénomination", enabled ? await c.enableDenom(sid, d) : await c.disableDenom(sid, d))
    );
  }
}
