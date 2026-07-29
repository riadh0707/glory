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
  onLogLine: (callback: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.LogLine, (_event, line: string) => callback(line));
  },
  onEvent: (callback: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.EventReceived, (_event, line: string) => callback(line));
  },
});
