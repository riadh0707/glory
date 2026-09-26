import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "../shared/ipc-channels";

/**
 * Pont contextIsolation : le renderer n'a aucun accès Node/Electron direct
 * (nodeIntegration: false dans main.ts) — seules ces fonctions explicites
 * sont exposées via `window.api`.
 */
contextBridge.exposeInMainWorld("api", {
  connect: () => ipcRenderer.invoke(IpcChannels.SessionConnect),
  status: () => ipcRenderer.invoke(IpcChannels.SessionStatus),
  disconnect: () => ipcRenderer.invoke(IpcChannels.SessionDisconnect),
  startCashin: () => ipcRenderer.invoke(IpcChannels.SessionStartCashin),
  endCashin: () => ipcRenderer.invoke(IpcChannels.SessionEndCashin),
  change: (amount: string) => ipcRenderer.invoke(IpcChannels.SessionChange, amount),
  startReplenishEntrance: () => ipcRenderer.invoke(IpcChannels.SessionStartReplenishEntrance),
  endReplenishEntrance: () => ipcRenderer.invoke(IpcChannels.SessionEndReplenishEntrance),
  lockUnit: () => ipcRenderer.invoke(IpcChannels.SessionLockUnit),
  unlockUnit: () => ipcRenderer.invoke(IpcChannels.SessionUnlockUnit),
  inventory: () => ipcRenderer.invoke(IpcChannels.SessionInventory),
  openExitCover: () => ipcRenderer.invoke(IpcChannels.SessionOpenExitCover),
  closeExitCover: () => ipcRenderer.invoke(IpcChannels.SessionCloseExitCover),
  romVersion: () => ipcRenderer.invoke(IpcChannels.SessionRomVersion),
  adjustTime: () => ipcRenderer.invoke(IpcChannels.SessionAdjustTime),
  getSettingFile: (fileName: string) => ipcRenderer.invoke(IpcChannels.SessionGetSettingFile, fileName),
  enableDenom: (params: { cc: string; fv: string; devid: string }) =>
    ipcRenderer.invoke(IpcChannels.SessionEnableDenom, params),
  disableDenom: (params: { cc: string; fv: string; devid: string }) =>
    ipcRenderer.invoke(IpcChannels.SessionDisableDenom, params),
  setExchangeRate: (params: { from: string; to: string; rate: string }) =>
    ipcRenderer.invoke(IpcChannels.SessionSetExchangeRate, params),
  reset: () => ipcRenderer.invoke(IpcChannels.SessionReset),
  cashinCancel: () => ipcRenderer.invoke(IpcChannels.SessionCashinCancel),
  changeCancel: () => ipcRenderer.invoke(IpcChannels.SessionChangeCancel),
  replenishEntranceCancel: () => ipcRenderer.invoke(IpcChannels.SessionReplenishEntranceCancel),
  cashout: (params: { cc: string; fv: string; devid: string; piece: number }) =>
    ipcRenderer.invoke(IpcChannels.SessionCashout, params),
  returnCash: () => ipcRenderer.invoke(IpcChannels.SessionReturnCash),
  generateDiagnosticReport: () => ipcRenderer.invoke(IpcChannels.DiagnosticGenerateReport),
  reportRendererError: (context: string, message: string, stack: string | undefined) =>
    ipcRenderer.invoke(IpcChannels.DiagnosticReportRendererError, context, message, stack),
  dayReport: () => ipcRenderer.invoke(IpcChannels.DiagnosticDayReport),
  fccConfigGet: () => ipcRenderer.invoke(IpcChannels.FccConfigGet),
  fccConfigSave: (config: unknown) => ipcRenderer.invoke(IpcChannels.FccConfigSave, config),
  onLogLine: (callback: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.LogLine, (_event, line: string) => callback(line));
  },
  onEvent: (callback: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.EventReceived, (_event, line: string) => callback(line));
  },
});
