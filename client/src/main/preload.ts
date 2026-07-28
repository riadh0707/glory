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
  onLogLine: (callback: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.LogLine, (_event, line: string) => callback(line));
  },
  onEvent: (callback: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.EventReceived, (_event, line: string) => callback(line));
  },
});
