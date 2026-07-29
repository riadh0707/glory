import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import * as path from "path";
import { IpcChannels } from "../shared/ipc-channels";
import { FccSoapClient } from "../core/soap-client";
import { SessionStateMachine, SessionState } from "../core/session-state-machine";
import { EventListener } from "../core/event-listener";
import { HistoryStore } from "../core/history-store";
import { getModelConfig, isConfirmedModel } from "../core/model-adapter";

// Modèle utilisé par ce prototype : la VM simulateur CI-10 du SDK, seule
// instance dont l'endpoint a été vérifié empiriquement (docs/architecture.md).
// CI-10X/CI-50 sont déclarés dans core/model-adapter mais nécessitent une
// config d'environnement (endpoint non vérifié) ; CI-05 est un point
// d'extension volontairement non implémenté (voir core/model-adapter/models/ci-05.ts).
const ACTIVE_MODEL_ID = "CI-10";

const DEVICE_NAME = "glory-client-prototype";
const USER_ID = "posadmin";
const USER_PWD = "";

let mainWindow: BrowserWindow | null = null;
const historyStore = new HistoryStore(path.join(__dirname, "..", "..", "data", "glory-client.db"));
const stateMachine = new SessionStateMachine();

let soapClient: FccSoapClient | null = null;
let eventListener: EventListener | null = null;
let sessionId: string | undefined;

function sendLog(line: string): void {
  mainWindow?.webContents.send(IpcChannels.LogLine, line);
}

function sendEvent(line: string): void {
  mainWindow?.webContents.send(IpcChannels.EventReceived, line);
}

interface ConnectResult {
  ok: boolean;
  message: string;
  state: SessionState;
}

async function handleConnect(): Promise<ConnectResult> {
  const modelConfig = getModelConfig(ACTIVE_MODEL_ID);
  if (!isConfirmedModel(modelConfig)) {
    const message = `Modèle "${ACTIVE_MODEL_ID}" non confirmé (${modelConfig.sourceNote}) — connexion refusée.`;
    sendLog(message);
    return { ok: false, message, state: stateMachine.getState() };
  }
  if (!modelConfig.soapEndpoint) {
    const message = `Aucun endpoint SOAP configuré pour "${ACTIVE_MODEL_ID}" (${modelConfig.sourceNote}).`;
    sendLog(message);
    return { ok: false, message, state: stateMachine.getState() };
  }

  try {
    stateMachine.assertCanOpen();

    // Étape 3 : le serveur TCP doit démarrer AVANT RegisterEvent (consigne du
    // sprint), pour être prêt à recevoir dès que le FCC commence à émettre.
    eventListener = new EventListener({
      mode: modelConfig.eventListener.mode,
      tcpPort: modelConfig.eventListener.tcpPort,
      logger: (source, raw) => {
        const line = `[TCP EVENT] ${source} ${raw}`;
        sendLog(line);
        sendEvent(line);
        historyStore.record("raw-tcp-event", source, raw);
      },
    });
    await eventListener.start();
    sendLog(`Écouteur TCP démarré sur le port ${modelConfig.eventListener.tcpPort}.`);

    soapClient = await FccSoapClient.create({
      endpoint: modelConfig.soapEndpoint,
      rejectUnauthorized: modelConfig.tls.rejectUnauthorized,
      logger: (direction, operation, payload) => {
        const line = `[SOAP ${direction === "request" ? "→" : "←"}] ${operation} ${JSON.stringify(payload)}`;
        sendLog(line);
        historyStore.record(direction === "request" ? "soap-request" : "soap-response", operation, payload);
      },
    });

    const openResult = await soapClient.open(USER_ID, USER_PWD, DEVICE_NAME);
    sendLog(`Open → result ${openResult.resultDescription}`);
    if (openResult.result !== 0 || !openResult.sessionId) {
      return {
        ok: false,
        message: `Échec Open : ${openResult.resultDescription}`,
        state: stateMachine.getState(),
      };
    }
    sessionId = openResult.sessionId;
    stateMachine.onOpened();

    stateMachine.assertCanRegisterEvent();
    // Adresse de la caisse elle-même : le FCC doit pouvoir ouvrir une
    // connexion TCP retour vers ce port (docs/event-system.md). `127.0.0.1`
    // NE FONCTIONNE PAS — vérifié empiriquement le 2026-07-28 : le FCC est
    // une machine distincte (même en VM), donc 127.0.0.1 y désigne le FCC
    // lui-même, jamais la caisse. Il faut l'IP réelle de la caisse sur le
    // réseau partagé avec le FCC — pour la VM simulateur (192.168.0.0/24),
    // c'est l'adresse de l'hôte de développement sur ce sous-réseau
    // (192.168.0.1, voir docs/architecture.md). À rendre configurable pour un
    // déploiement multi-machine (actuellement en dur, cas mono-poste de dev).
    const CAISSE_IP_ON_FCC_SUBNET = "192.168.0.1";
    const registerResult = await soapClient.registerEvent({
      sessionId,
      url: CAISSE_IP_ON_FCC_SUBNET,
      port: modelConfig.eventListener.tcpPort,
    });
    sendLog(`RegisterEvent → result ${registerResult.resultDescription}`);

    stateMachine.assertCanOccupy();
    const occupyResult = await soapClient.occupy(sessionId);
    sendLog(`Occupy → result ${occupyResult.resultDescription}`);
    if (occupyResult.result !== 0) {
      return {
        ok: false,
        message: `Échec Occupy : ${occupyResult.resultDescription}`,
        state: stateMachine.getState(),
      };
    }
    stateMachine.onOccupied();

    historyStore.record("state-transition", null, { state: stateMachine.getState() });
    return {
      ok: true,
      message: `Connecté. SessionID=${sessionId}, état=${stateMachine.getState()}.`,
      state: stateMachine.getState(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

interface StatusResult {
  ok: boolean;
  message: string;
  raw?: unknown;
  state: SessionState;
}

async function handleStatus(): Promise<StatusResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const status = await soapClient.getStatus(sessionId);
    sendLog(`GetStatus → result ${status.resultDescription}`);
    return { ok: true, message: status.resultDescription, raw: status.raw, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

interface DisconnectResult {
  ok: boolean;
  message: string;
  state: SessionState;
}

async function handleDisconnect(): Promise<DisconnectResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanRelease();
    const releaseResult = await soapClient.release(sessionId);
    sendLog(`Release → result ${releaseResult.resultDescription}`);
    stateMachine.onReleased();

    stateMachine.assertCanClose();
    const closeResult = await soapClient.close(sessionId);
    sendLog(`Close → result ${closeResult.resultDescription}`);
    stateMachine.onClosed();

    await eventListener?.stop();
    sendLog("Écouteur TCP arrêté.");

    historyStore.record("state-transition", null, { state: stateMachine.getState() });
    soapClient = null;
    eventListener = null;
    sessionId = undefined;
    return { ok: true, message: "Déconnecté proprement.", state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

interface TransactionResult {
  ok: boolean;
  message: string;
  state: SessionState;
}

async function handleStartCashin(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.startCashin(sessionId);
    sendLog(`StartCashin → result ${result.resultDescription}`);
    historyStore.record("soap-response", "StartCashinOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleEndCashin(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.endCashin(sessionId);
    // `manualDeposit` n'est pas le montant physiquement compté (voir
    // core/soap-client, docstring endCashin) — le détail réel est dans `cash`.
    const message = `${result.resultDescription} — espèces comptées : ${JSON.stringify(result.cash ?? "aucune")}`;
    sendLog(`EndCashin → result ${message}`);
    historyStore.record("soap-response", "EndCashinOperation", result);
    return { ok: result.result === 0, message, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleChange(amount: string): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    sendLog(`Change(${amount}) → en attente du dépôt client (appel bloquant, voir docs/open-questions.md)...`);
    const result = await soapClient.change(sessionId, amount);
    const message = `${result.resultDescription} — espèces : ${JSON.stringify(result.cash ?? "aucune")}`;
    sendLog(`Change(${amount}) → result ${message}`);
    historyStore.record("soap-response", "ChangeOperation", result);
    return { ok: result.result === 0, message, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleStartReplenishEntrance(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.startReplenishmentFromEntrance(sessionId);
    sendLog(`StartReplenishmentFromEntrance → result ${result.resultDescription}`);
    historyStore.record("soap-response", "StartReplenishmentFromEntranceOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleEndReplenishEntrance(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.endReplenishmentFromEntrance(sessionId);
    const message = `${result.resultDescription} — espèces : ${JSON.stringify(result.cash ?? "aucune")}`;
    sendLog(`EndReplenishmentFromEntrance → result ${message}`);
    historyStore.record("soap-response", "EndReplenishmentFromEntranceOperation", result);
    return { ok: result.result === 0, message, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleLockUnit(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.lockUnit(sessionId, 1);
    sendLog(`LockUnit(RBW-100) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "LockUnitOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleUnlockUnit(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.unlockUnit(sessionId, 1);
    sendLog(`UnlockUnit(RBW-100) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "UnLockUnitOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

interface InventoryResult {
  ok: boolean;
  message: string;
  raw?: unknown;
  state: SessionState;
}

async function handleInventory(): Promise<InventoryResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.inventory(sessionId, 0);
    sendLog(`Inventory → result ${result.resultDescription}`);
    historyStore.record("soap-response", "InventoryOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, raw: result.raw, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleOpenExitCover(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.openExitCover(sessionId);
    sendLog(`OpenExitCover → result ${result.resultDescription}`);
    historyStore.record("soap-response", "OpenExitCoverOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleCloseExitCover(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.closeExitCover(sessionId);
    sendLog(`CloseExitCover → result ${result.resultDescription}`);
    historyStore.record("soap-response", "CloseExitCoverOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleRomVersion(): Promise<InventoryResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.romVersion(sessionId);
    sendLog(`RomVersion → result ${result.resultDescription}`);
    historyStore.record("soap-response", "RomVersionOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, raw: result.raw, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleAdjustTime(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    // Aligne le FCC sur l'heure système de la caisse — pas d'UI dédiée pour
    // choisir une date/heure arbitraire dans ce sprint (voir docs/open-questions.md
    // si un besoin de réglage manuel apparaît).
    const now = new Date();
    const result = await soapClient.adjustTime(
      sessionId,
      { month: now.getMonth() + 1, day: now.getDate(), year: now.getFullYear() },
      { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() }
    );
    sendLog(`AdjustTime → result ${result.resultDescription}`);
    historyStore.record("soap-response", "AdjustTimeOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleGetSettingFile(fileName: string): Promise<InventoryResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.getSettingFile(sessionId, fileName);
    sendLog(`GetSettingFile(${fileName}) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "GetSettingFileOperation", result);
    return {
      ok: result.result === 0,
      message: result.resultDescription,
      raw: result.settingFile,
      state: stateMachine.getState(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

interface DenomParams {
  cc: string;
  fv: string;
  devid: string;
}

async function handleEnableDenom(params: DenomParams): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.enableDenom(sessionId, [{ cc: params.cc, fv: params.fv, devid: params.devid, piece: 0 }]);
    sendLog(`EnableDenom(${params.cc} ${params.fv} devid=${params.devid}) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "EnableDenomOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleDisableDenom(params: DenomParams): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.disableDenom(sessionId, [{ cc: params.cc, fv: params.fv, devid: params.devid, piece: 0 }]);
    sendLog(`DisableDenom(${params.cc} ${params.fv} devid=${params.devid}) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "DisableDenomOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleSetExchangeRate(params: { from: string; to: string; rate: string }): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.setExchangeRate(sessionId, [{ from: params.from, to: params.to, rate: params.rate }]);
    sendLog(`SetExchangeRate(${params.from}→${params.to}=${params.rate}) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "SetExchangeRateOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleReset(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    // Reset peut rester bloqué indéfiniment sur ce simulateur si l'appareil
    // est dans un état d'erreur qu'il ne sait pas nettoyer (voir docstring
    // core/soap-client reset() et docs/open-questions.md, scénario cat.2/3)
    // — on borne l'attente côté client plutôt que de geler l'UI sans fin.
    const RESET_TIMEOUT_MS = 30_000;
    sendLog("Reset → appel en cours (peut prendre jusqu'à ~30s)...");
    const result = await Promise.race([
      soapClient.reset(sessionId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Reset sans réponse après ${RESET_TIMEOUT_MS / 1000}s — l'appareil est probablement bloqué, une intervention manuelle (redémarrage service/émulateur) peut être nécessaire.`)), RESET_TIMEOUT_MS)
      ),
    ]);
    sendLog(`Reset → result ${result.resultDescription}`);
    historyStore.record("soap-response", "ResetOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleCashinCancel(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.cashinCancel(sessionId);
    const message = `${result.resultDescription} — espèces : ${JSON.stringify(result.cash ?? "aucune")}`;
    sendLog(`CashinCancel → result ${message}`);
    historyStore.record("soap-response", "CashinCancelOperation", result);
    return { ok: result.result === 0, message, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleChangeCancel(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.changeCancel(sessionId, 0);
    sendLog(`ChangeCancel → result ${result.resultDescription} (le résultat d'annulation réel arrive dans la réponse de l'appel Change en attente, avec result=1)`);
    historyStore.record("soap-response", "ChangeCancelOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleReplenishEntranceCancel(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.replenishmentFromEntranceCancel(sessionId);
    const message = `${result.resultDescription} — espèces : ${JSON.stringify(result.cash ?? "aucune")}`;
    sendLog(`ReplenishmentFromEntranceCancel → result ${message}`);
    historyStore.record("soap-response", "ReplenishmentFromEntranceCancelOperation", result);
    return { ok: result.result === 0, message, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleCashout(params: { cc: string; fv: string; devid: string; piece: number }): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.cashout(sessionId, [params]);
    const message = `${result.resultDescription} — espèces : ${JSON.stringify(result.cash ?? "aucune")}`;
    sendLog(`Cashout(${params.cc} ${params.fv} x${params.piece}) → result ${message}`);
    historyStore.record("soap-response", "CashoutOperation", result);
    return { ok: result.result === 0, message, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

async function handleReturnCash(): Promise<TransactionResult> {
  if (!soapClient || !sessionId) {
    return { ok: false, message: "Non connecté.", state: stateMachine.getState() };
  }
  try {
    stateMachine.assertCanTransact();
    const result = await soapClient.returnCash(sessionId, 2);
    sendLog(`ReturnCash(Coin) → result ${result.resultDescription}`);
    historyStore.record("soap-response", "ReturnCashOperation", result);
    return { ok: result.result === 0, message: result.resultDescription, state: stateMachine.getState() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] ${message}`);
    return { ok: false, message, state: stateMachine.getState() };
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, "..", "main", "preload.js"),
      // contextIsolation reste la vraie barrière de sécurité (le renderer ne
      // touche jamais Node/Electron directement, uniquement via window.api).
      // sandbox: false est nécessaire ici — le preload sandboxé d'Electron a
      // son propre require() restreint qui ne résout pas les imports relatifs
      // vers d'autres fichiers du projet compilé (vérifié empiriquement le
      // 2026-07-28 : "Error: module not found: ../shared/ipc-channels" dans
      // preloadRequire du sandbox_bundle — c'était la cause réelle de
      // window.api toujours undefined, donc de tous les boutons UI inertes).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "ui", "index.html"));
}

ipcMain.handle(IpcChannels.SessionConnect, async (_event: IpcMainInvokeEvent) => handleConnect());
ipcMain.handle(IpcChannels.SessionStatus, async (_event: IpcMainInvokeEvent) => handleStatus());
ipcMain.handle(IpcChannels.SessionDisconnect, async (_event: IpcMainInvokeEvent) => handleDisconnect());
ipcMain.handle(IpcChannels.SessionStartCashin, async (_event: IpcMainInvokeEvent) => handleStartCashin());
ipcMain.handle(IpcChannels.SessionEndCashin, async (_event: IpcMainInvokeEvent) => handleEndCashin());
ipcMain.handle(IpcChannels.SessionChange, async (_event: IpcMainInvokeEvent, amount: string) =>
  handleChange(amount)
);
ipcMain.handle(IpcChannels.SessionStartReplenishEntrance, async (_event: IpcMainInvokeEvent) =>
  handleStartReplenishEntrance()
);
ipcMain.handle(IpcChannels.SessionEndReplenishEntrance, async (_event: IpcMainInvokeEvent) =>
  handleEndReplenishEntrance()
);
ipcMain.handle(IpcChannels.SessionLockUnit, async (_event: IpcMainInvokeEvent) => handleLockUnit());
ipcMain.handle(IpcChannels.SessionUnlockUnit, async (_event: IpcMainInvokeEvent) => handleUnlockUnit());
ipcMain.handle(IpcChannels.SessionInventory, async (_event: IpcMainInvokeEvent) => handleInventory());
ipcMain.handle(IpcChannels.SessionOpenExitCover, async (_event: IpcMainInvokeEvent) => handleOpenExitCover());
ipcMain.handle(IpcChannels.SessionCloseExitCover, async (_event: IpcMainInvokeEvent) => handleCloseExitCover());
ipcMain.handle(IpcChannels.SessionRomVersion, async (_event: IpcMainInvokeEvent) => handleRomVersion());
ipcMain.handle(IpcChannels.SessionAdjustTime, async (_event: IpcMainInvokeEvent) => handleAdjustTime());
ipcMain.handle(IpcChannels.SessionGetSettingFile, async (_event: IpcMainInvokeEvent, fileName: string) =>
  handleGetSettingFile(fileName)
);
ipcMain.handle(IpcChannels.SessionEnableDenom, async (_event: IpcMainInvokeEvent, params: DenomParams) =>
  handleEnableDenom(params)
);
ipcMain.handle(IpcChannels.SessionDisableDenom, async (_event: IpcMainInvokeEvent, params: DenomParams) =>
  handleDisableDenom(params)
);
ipcMain.handle(
  IpcChannels.SessionSetExchangeRate,
  async (_event: IpcMainInvokeEvent, params: { from: string; to: string; rate: string }) =>
    handleSetExchangeRate(params)
);
ipcMain.handle(IpcChannels.SessionReset, async (_event: IpcMainInvokeEvent) => handleReset());
ipcMain.handle(IpcChannels.SessionCashinCancel, async (_event: IpcMainInvokeEvent) => handleCashinCancel());
ipcMain.handle(IpcChannels.SessionChangeCancel, async (_event: IpcMainInvokeEvent) => handleChangeCancel());
ipcMain.handle(IpcChannels.SessionReplenishEntranceCancel, async (_event: IpcMainInvokeEvent) =>
  handleReplenishEntranceCancel()
);
ipcMain.handle(
  IpcChannels.SessionCashout,
  async (_event: IpcMainInvokeEvent, params: { cc: string; fv: string; devid: string; piece: number }) =>
    handleCashout(params)
);
ipcMain.handle(IpcChannels.SessionReturnCash, async (_event: IpcMainInvokeEvent) => handleReturnCash());

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  historyStore.close();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
