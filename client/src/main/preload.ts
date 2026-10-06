import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "../shared/ipc-channels";

/**
 * Pont contextIsolation : le renderer n'a aucun accès Node/Electron, seulement
 * `window.api.call(action, ...args)` (liste blanche côté main) et trois flux
 * d'abonnement.
 */
contextBridge.exposeInMainWorld("api", {
  call: (action: string, ...args: unknown[]) => ipcRenderer.invoke(IpcChannels.Call, action, ...args),
  onLog: (cb: (line: string) => void) => {
    ipcRenderer.on(IpcChannels.Log, (_e, line: string) => cb(line));
  },
  onFccEvent: (cb: (e: unknown) => void) => {
    ipcRenderer.on(IpcChannels.FccEvent, (_e, ev: unknown) => cb(ev));
  },
  onState: (cb: (s: unknown) => void) => {
    ipcRenderer.on(IpcChannels.State, (_e, s: unknown) => cb(s));
  },
  onLicense: (cb: (s: unknown) => void) => {
    ipcRenderer.on(IpcChannels.License, (_e, s: unknown) => cb(s));
  },
});
