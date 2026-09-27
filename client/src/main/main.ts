import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import * as path from "path";
import { IpcChannels } from "../shared/ipc-channels";
import { FccSoapClient } from "../core/soap-client";
import { SessionStateMachine, SessionState } from "../core/session-state-machine";
import { EventListener } from "../core/event-listener";
import { HistoryStore } from "../core/history-store";
import { getModelConfig, isConfirmedModel } from "../core/model-adapter";
import { generateDiagnosticReport, DiagnosticReportEnvironment } from "../core/diagnostic-report";
import { loadFccConfig, saveFccConfig, FccConnectionConfig } from "../core/fcc-config";
import { loadReceiptSettings, saveReceiptSettings, takeNextTicketNumber, ReceiptSettings } from "../core/receipt-settings";

// Modèle actif : CI-10, seule instance dont l'endpoint a été vérifié
// empiriquement (docs/architecture.md). CI-10X/CI-50 sont déclarés dans
// core/model-adapter mais nécessitent une config d'environnement (endpoint
// non vérifié) ; CI-05 est un point d'extension non implémenté (voir
// core/model-adapter/models/ci-05.ts).
const ACTIVE_MODEL_ID = "CI-10";

const DEVICE_NAME = "glory-fcc-client";
// Identifiants par défaut — surchargés par connConfig.userId/userPwd
// (userData/fcc-config.json, voir core/fcc-config) si le client les a
// renseignés. Ne fonctionnent QUE contre la VM simulateur du SDK
// (SoapUserCheck désactivé dedans) — un terminal réel exige généralement de
// vrais identifiants, voir la docstring de FccConnectionConfig.userId.
const DEFAULT_USER_ID = "posadmin";
const DEFAULT_USER_PWD = "";

// Nom affiché par l'OS (menu Démarrer/barre des tâches Windows, launcher
// Linux) — sans ça, Electron utilise par défaut le nom `package.json` en
// kebab-case ("glory-fcc-client") dans certains contextes système. Appelé
// AVANT app.getPath("userData") ci-dessous pour que ce dossier porte aussi
// ce nom plutôt que le kebab-case par défaut.
app.setName("Glory FCC Client");

/**
 * **Piège critique (2026-07-29)** : `DATA_DIR` était auparavant calculé par
 * rapport à `__dirname` (`dist/main/../..`) — fonctionnait en dev, mais une
 * fois l'app empaquetée, `dist/` est contenu dans `app.asar` (archive
 * **en lecture seule**). `HistoryStore` tentait alors de créer son dossier
 * de base SQLite *à l'intérieur de l'asar*, provoquant un crash immédiat au
 * démarrage (avant même l'affichage de la fenêtre, avant l'enregistrement
 * des handlers `uncaughtException` ci-dessous) — confirmé en testant
 * `release/win-unpacked/Glory FCC Client.exe`, fenêtre "Error" au lancement.
 * `app.getPath("userData")` est le dossier standard Electron pour les
 * données persistantes par utilisateur (`%APPDATA%/Glory FCC Client` sur
 * Windows, `~/.config/Glory FCC Client` sur Linux) — toujours accessible en
 * écriture, dev comme empaqueté.
 */
const DATA_DIR = app.getPath("userData");
const APP_STARTED_AT = new Date().toISOString();

let mainWindow: BrowserWindow | null = null;
const historyStore = new HistoryStore(path.join(DATA_DIR, "glory-client.db"));
const stateMachine = new SessionStateMachine();

let soapClient: FccSoapClient | null = null;
let eventListener: EventListener | null = null;
let sessionId: string | undefined;

/**
 * Toute ligne `[ERREUR]` est aussi persistée dans `historyStore` — avant ce
 * changement (2026-07-29), les erreurs n'apparaissaient que dans le panneau
 * de log de l'UI (perdues à la fermeture de l'app), jamais dans la base
 * SQLite ni dans un export. Ajouté spécifiquement pour que le rapport de
 * diagnostic (voir handleGenerateReport) capture aussi les échecs, pas
 * seulement les succès SOAP — nécessaire pour diagnostiquer un problème
 * rencontré par le client sur un FCC réel sans avoir à lui redemander une
 * copie de son écran/log au moment exact de l'incident.
 */
function sendLog(line: string): void {
  mainWindow?.webContents.send(IpcChannels.LogLine, line);
  if (line.startsWith("[ERREUR]")) {
    historyStore.record("error", null, { message: line });
  }
}

function sendEvent(line: string): void {
  mainWindow?.webContents.send(IpcChannels.EventReceived, line);
}

/**
 * Filet de sécurité : capture toute exception qui échapperait aux try/catch
 * des handlers individuels (bug non anticipé dans le code, pas seulement les
 * échecs SOAP attendus) — sans ça, une exception non gérée dans le
 * processus main tuerait l'app silencieusement sans laisser de trace
 * exploitable pour le rapport de diagnostic.
 */
process.on("uncaughtException", (err) => {
  sendLog(`[ERREUR] Exception non gérée (main) : ${err.message}`);
  historyStore.record("error", "uncaughtException", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  sendLog(`[ERREUR] Promesse rejetée non gérée (main) : ${message}`);
  historyStore.record("error", "unhandledRejection", { message, stack });
});

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

  // Surchargé par userData/fcc-config.json si présent (voir
  // core/fcc-config) — nécessaire pour pointer vers un FCC réel plutôt que
  // la VM simulateur du SDK (valeurs par défaut de model-adapter/ci-10.ts).
  const connConfig: FccConnectionConfig = loadFccConfig(DATA_DIR, {
    soapEndpoint: modelConfig.soapEndpoint,
    rejectUnauthorized: modelConfig.tls.rejectUnauthorized,
    eventTcpPort: modelConfig.eventListener.tcpPort,
    callbackIp: "192.168.0.1",
    userId: DEFAULT_USER_ID,
    userPwd: DEFAULT_USER_PWD,
  });

  try {
    stateMachine.assertCanOpen();

    // Étape 3 : le serveur TCP doit démarrer AVANT RegisterEvent (consigne du
    // sprint), pour être prêt à recevoir dès que le FCC commence à émettre.
    eventListener = new EventListener({
      mode: modelConfig.eventListener.mode,
      tcpPort: connConfig.eventTcpPort,
      logger: (source, raw) => {
        const line = `[TCP EVENT] ${source} ${raw}`;
        sendLog(line);
        sendEvent(line);
        historyStore.record("raw-tcp-event", source, raw);
      },
    });
    await eventListener.start();
    sendLog(`Écouteur TCP démarré sur le port ${connConfig.eventTcpPort}.`);

    soapClient = await FccSoapClient.create({
      endpoint: connConfig.soapEndpoint,
      rejectUnauthorized: connConfig.rejectUnauthorized,
      logger: (direction, operation, payload) => {
        const line = `[SOAP ${direction === "request" ? "→" : "←"}] ${operation} ${JSON.stringify(payload)}`;
        sendLog(line);
        historyStore.record(direction === "request" ? "soap-request" : "soap-response", operation, payload);
      },
    });

    const openResult = await soapClient.open(connConfig.userId, connConfig.userPwd, DEVICE_NAME);
    sendLog(`Open → result ${openResult.resultDescription}`);
    if (openResult.result !== 0 || !openResult.sessionId) {
      await cleanupFailedConnect();
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
    // lui-même, jamais la caisse. Configurable via connConfig.callbackIp
    // (userData/fcc-config.json, voir core/fcc-config) — sur un déploiement
    // réel, c'est l'IP de CETTE machine sur le même réseau que le FCC.
    const registerResult = await soapClient.registerEvent({
      sessionId,
      url: connConfig.callbackIp,
      port: connConfig.eventTcpPort,
    });
    sendLog(`RegisterEvent → result ${registerResult.resultDescription}`);

    stateMachine.assertCanOccupy();
    const occupyResult = await soapClient.occupy(sessionId);
    sendLog(`Occupy → result ${occupyResult.resultDescription}`);
    if (occupyResult.result !== 0) {
      await cleanupFailedConnect();
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
    await cleanupFailedConnect();
    return { ok: false, message, state: stateMachine.getState() };
  }
}

/**
 * **Bug réel trouvé via un rapport de diagnostic client (2026-09-07)** :
 * quand `handleConnect()` échouait après avoir démarré `eventListener`
 * (ex. `ETIMEDOUT` en tentant de joindre un mauvais endpoint SOAP), le
 * listener restait ouvert sur son port TCP — jamais arrêté. Au clic suivant
 * sur "Connecter", un nouveau `EventListener` tentait de reprendre le même
 * port → `EADDRINUSE`, empêchant toute nouvelle tentative sans redémarrer
 * l'app entière. Le rapport montrait exactement ce cycle : le client avait
 * identifié "Glory FCC Client" lui-même comme processus occupant le port.
 * Cette fonction referme proprement l'écouteur (et réinitialise l'état de
 * session) sur **tout** chemin d'échec de `handleConnect()`.
 */
async function cleanupFailedConnect(): Promise<void> {
  if (eventListener) {
    try {
      await eventListener.stop();
      sendLog("Écouteur TCP arrêté (nettoyage après échec de connexion).");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendLog(`[ERREUR] Échec de l'arrêt de l'écouteur TCP après connexion ratée : ${message}`);
    }
    eventListener = null;
  }
  soapClient = null;
  sessionId = undefined;
  stateMachine.forceClosed();
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
  amountCents?: number;
}

/** Somme en centimes de toutes les dénominations d'un champ `cash` (fv en
 * centimes, voir aggregateDenoms côté renderer). */
function sumCashCents(cash: unknown): number {
  return flattenCashDenoms(cash).reduce((sum, l) => sum + l.piece * Number(l.fv), 0);
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
    return { ok: result.result === 0, message, state: stateMachine.getState(), amountCents: sumCashCents(result.cash) };
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
    return { ok: result.result === 0, message, state: stateMachine.getState(), amountCents: Number(amount) || 0 };
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
  /** Lignes de dénomination extraites de `raw` (Cash + CashUnits), pour un
   * affichage tableau lisible côté UI — voir `extractInventoryLines`. Vide
   * pour les autres opérations qui réutilisent ce type (RomVersion,
   * GetSettingFile). */
  lines?: DenomLine[];
  state: SessionState;
}

/**
 * Regroupe les dénominations trouvées dans une réponse `InventoryOperation`
 * (`Cash` — stock courant — et `CashUnits` — capacité par unité/cassette,
 * WSDL BrueBoxService.wsdl:390-401/560-574) pour l'affichage tableau. Deux
 * niveaux d'imbrication différents selon le champ (`Cash.Denomination`
 * directement, vs `CashUnits[].CashUnit[].Denomination`) — voir
 * `flattenCashDenoms`, qui ne gère qu'un seul niveau, d'où la boucle
 * supplémentaire ici pour `CashUnits`.
 */
function extractInventoryLines(raw: unknown): DenomLine[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const lines: DenomLine[] = [...flattenCashDenoms(r.Cash)];
  for (const cashUnitsBlock of asArray(r.CashUnits as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    if (!cashUnitsBlock || typeof cashUnitsBlock !== "object") continue;
    for (const cashUnit of asArray((cashUnitsBlock as Record<string, unknown>).CashUnit as unknown)) {
      lines.push(...flattenCashDenoms(cashUnit));
    }
  }
  return lines;
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
    return {
      ok: result.result === 0,
      message: result.resultDescription,
      raw: result.raw,
      lines: extractInventoryLines(result.raw),
      state: stateMachine.getState(),
    };
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

function currentFccConfig(): FccConnectionConfig {
  const modelConfig = getModelConfig(ACTIVE_MODEL_ID);
  return loadFccConfig(DATA_DIR, {
    soapEndpoint: isConfirmedModel(modelConfig) ? (modelConfig.soapEndpoint ?? "") : "",
    rejectUnauthorized: isConfirmedModel(modelConfig) ? modelConfig.tls.rejectUnauthorized : true,
    eventTcpPort: isConfirmedModel(modelConfig) ? modelConfig.eventListener.tcpPort : 55561,
    callbackIp: "192.168.0.1",
    userId: DEFAULT_USER_ID,
    userPwd: DEFAULT_USER_PWD,
  });
}

function handleFccConfigGet(): FccConnectionConfig {
  return currentFccConfig();
}

function handleFccConfigSave(config: FccConnectionConfig): FccConnectionConfig {
  saveFccConfig(DATA_DIR, config);
  sendLog(
    `[UI] Configuration FCC enregistrée → endpoint=${config.soapEndpoint} callbackIp=${config.callbackIp} eventPort=${config.eventTcpPort} rejectUnauthorized=${config.rejectUnauthorized}`
  );
  historyStore.record("app-lifecycle", "fcc-config-save", config);
  return config;
}

/** Normalise un noeud XML→JS qui peut être un objet unique ou un tableau
 * (comportement de la lib "soap" selon le nombre d'occurrences réellement
 * présentes dans la réponse) — utilisé pour parcourir `Cash`/`Denomination`
 * sans avoir à deviner la forme exacte à chaque appel. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

interface DenomLine {
  cc: string;
  fv: string;
  devid: string;
  piece: number;
}

/**
 * Extrait les lignes de dénomination (devise/valeur faciale/pièces) d'un
 * champ `cash` tel que renvoyé par `core/soap-client` (`response.Cash`,
 * WSDL `CashType` — `Denomination[]` avec attributs `cc`/`fv`/`devid` et
 * élément `Piece`, voir BrueBoxService.wsdl:516-531). Utilisée pour
 * l'inventaire ET le rapport du jour — seule fonction qui connaît cette
 * structure XML, pour ne pas la redupliquer avec des hypothèses différentes.
 */
function flattenCashDenoms(cash: unknown): DenomLine[] {
  const out: DenomLine[] = [];
  for (const block of asArray(cash as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    if (!block || typeof block !== "object") continue;
    const denoms = asArray((block as Record<string, unknown>).Denomination as unknown);
    for (const d of denoms) {
      if (!d || typeof d !== "object") continue;
      const node = d as Record<string, unknown>;
      const attrs = (node.attributes as Record<string, unknown> | undefined) ?? {};
      const cc = String(attrs.cc ?? node.cc ?? "?");
      const fv = String(attrs.fv ?? node.fv ?? "0");
      const devid = String(attrs.devid ?? node.devid ?? "?");
      const piece = Number(node.Piece ?? 0) || 0;
      if (piece > 0) out.push({ cc, fv, devid, piece });
    }
  }
  return out;
}

interface DayReportOperationTotal {
  operation: string;
  label: string;
  count: number;
  lines: DenomLine[];
  totalsByCurrency: Record<string, number>;
}

interface DayReportResponse {
  ok: boolean;
  message: string;
  generatedAt: string;
  dateLabel: string;
  operations: DayReportOperationTotal[];
  totalsByCurrency: Record<string, number>;
  errorCount: number;
}

/** Opérations dont le résultat contient des espèces pertinentes pour un
 * résumé de journée — voir docs/soap-operations.md. Le label est celui
 * affiché au client, pas le nom technique WSDL. */
const DAY_REPORT_OPERATIONS: Record<string, string> = {
  ChangeOperation: "Encaissements (Change)",
  EndCashinOperation: "Encaissements terminés",
  CashoutOperation: "Distributions manuelles (Cashout)",
  EndReplenishmentFromEntranceOperation: "Réapprovisionnements terminés",
  CashinCancelOperation: "Encaissements annulés (espèces rendues)",
  ReplenishmentFromEntranceCancelOperation: "Réapprovisionnements annulés",
};

/**
 * Résumé des transactions du jour (espèces encaissées/distribuées), pensé
 * pour être imprimé par le client en fin de journée — distinct du rapport de
 * diagnostic (celui-ci reste technique, pour le support). Agrège
 * `historyStore` plutôt que de tenir un compteur en mémoire : survit à un
 * redémarrage de l'app dans la même journée.
 *
 * Ne lit que les entrées `soap-response` **typées** (celles enregistrées par
 * chaque `handleXxx` avec `{result, resultDescription, cash}`), pas les
 * entrées brutes équivalentes déjà loguées automatiquement par le logger du
 * client SOAP (`core/soap-client`, méthode `call()`) — les deux partagent le
 * même `kind`/`operation`, mais seule la version typée expose `cash` sous une
 * forme homogène ; on les distingue par la présence de `resultDescription`.
 */
function handleDayReport(): DayReportResponse {
  const dateLabel = new Date().toISOString().slice(0, 10);
  const events = historyStore.getAllEvents().filter((ev) => ev.ts.startsWith(dateLabel));

  const byOperation = new Map<string, DayReportOperationTotal>();
  for (const [operation, label] of Object.entries(DAY_REPORT_OPERATIONS)) {
    byOperation.set(operation, { operation, label, count: 0, lines: [], totalsByCurrency: {} });
  }

  const totalsByCurrency: Record<string, number> = {};

  for (const ev of events) {
    if (ev.kind !== "soap-response" || !ev.operation) continue;
    const entry = byOperation.get(ev.operation);
    if (!entry) continue;
    const payload = ev.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || !("resultDescription" in payload)) continue; // entrée brute, pas typée

    entry.count += 1;
    const lines = flattenCashDenoms(payload.cash);
    for (const line of lines) {
      entry.lines.push(line);
      const value = (line.piece * Number(line.fv)) / 100;
      entry.totalsByCurrency[line.cc] = (entry.totalsByCurrency[line.cc] ?? 0) + value;
      totalsByCurrency[line.cc] = (totalsByCurrency[line.cc] ?? 0) + value;
    }
  }

  const errorCount = events.filter((ev) => ev.kind === "error").length;
  const operations = [...byOperation.values()].filter((op) => op.count > 0);

  return {
    ok: true,
    message: `Rapport du jour (${dateLabel}) : ${operations.length} type(s) d'opération, ${errorCount} erreur(s).`,
    generatedAt: new Date().toISOString(),
    dateLabel,
    operations,
    totalsByCurrency,
    errorCount,
  };
}

interface DiagnosticReportResponse {
  ok: boolean;
  message: string;
  jsonPath?: string;
  markdownPath?: string;
}

async function handleGenerateReport(): Promise<DiagnosticReportResponse> {
  try {
    const modelConfig = getModelConfig(ACTIVE_MODEL_ID);
    const env: DiagnosticReportEnvironment = {
      modelId: ACTIVE_MODEL_ID,
      soapEndpoint: (isConfirmedModel(modelConfig) ? modelConfig.soapEndpoint : undefined) ?? undefined,
      appStartedAt: APP_STARTED_AT,
      reportGeneratedAt: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}`,
      nodeVersion: process.version,
    };
    const events = historyStore.getAllEvents();
    const result = generateDiagnosticReport(path.join(DATA_DIR, "reports"), env, events);
    const message = `Rapport généré (${result.eventCount} événements, ${result.errorCount} erreurs) → ${result.markdownPath}`;
    sendLog(`[UI] Rapport de diagnostic → ${message}`);
    return { ok: true, message, jsonPath: result.jsonPath, markdownPath: result.markdownPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendLog(`[ERREUR] Génération du rapport de diagnostic : ${message}`);
    return { ok: false, message };
  }
}

/**
 * Le renderer n'a pas accès à `historyStore` (processus séparé) — cette
 * fonction lui donne un moyen de signaler ses propres erreurs (exceptions
 * JS dans un handler de clic, promesse IPC rejetée côté UI) pour qu'elles
 * atterrissent dans le même rapport de diagnostic que les erreurs SOAP.
 * Sans ça, un bug purement UI (ex. celui rencontré le 2026-07-29 où un clic
 * rapide sur "Déconnecter" laissait le bouton bloqué) resterait invisible
 * dans tout export destiné au client.
 */
function handleRendererError(context: string, message: string, stack: string | undefined): void {
  sendLog(`[ERREUR] (UI) ${context} : ${message}`);
  historyStore.record("error", `renderer:${context}`, { message, stack });
}

function loadMainApp(): void {
  mainWindow?.loadFile(path.join(__dirname, "..", "ui", "index.html"));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    // .png fonctionne comme icône de fenêtre/taskbar sur Windows et Linux en
    // exécution (dev comme empaqueté) ; l'icône .ico dédiée
    // (build/icon.ico) sert uniquement à l'exécutable/l'installeur Windows
    // (configuration electron-builder, voir docs/development-notes.md).
    icon: path.join(__dirname, "..", "..", "build", "icon.png"),
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
  loadMainApp();
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
ipcMain.handle(IpcChannels.DiagnosticGenerateReport, async (_event: IpcMainInvokeEvent) => handleGenerateReport());
ipcMain.handle(
  IpcChannels.DiagnosticReportRendererError,
  async (_event: IpcMainInvokeEvent, context: string, message: string, stack: string | undefined) =>
    handleRendererError(context, message, stack)
);
ipcMain.handle(IpcChannels.DiagnosticDayReport, async (_event: IpcMainInvokeEvent) => handleDayReport());
ipcMain.handle(IpcChannels.ReceiptSettingsGet, async () => loadReceiptSettings(DATA_DIR));
ipcMain.handle(IpcChannels.ReceiptSettingsSave, async (_event: IpcMainInvokeEvent, settings: ReceiptSettings) => {
  saveReceiptSettings(DATA_DIR, settings);
  return loadReceiptSettings(DATA_DIR);
});
ipcMain.handle(IpcChannels.ReceiptTakeNumber, async () => takeNextTicketNumber(DATA_DIR));
ipcMain.handle(IpcChannels.FccConfigGet,async (_event: IpcMainInvokeEvent) => handleFccConfigGet());
ipcMain.handle(IpcChannels.FccConfigSave, async (_event: IpcMainInvokeEvent, config: FccConnectionConfig) =>
  handleFccConfigSave(config)
);

historyStore.record("app-lifecycle", "start", {
  appStartedAt: APP_STARTED_AT,
  modelId: ACTIVE_MODEL_ID,
  platform: `${process.platform} ${process.arch}`,
  nodeVersion: process.version,
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  historyStore.record("app-lifecycle", "stop", { ts: new Date().toISOString() });
  historyStore.close();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
