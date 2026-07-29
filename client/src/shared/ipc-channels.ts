/**
 * Noms des canaux IPC partagés entre le processus main et le preload.
 * Fichier séparé pour éviter de dupliquer les chaînes littérales des deux côtés
 * du pont contextBridge (source d'erreurs classiques si elles divergent).
 */
export const IpcChannels = {
  SessionConnect: "session:connect",
  SessionStatus: "session:status",
  SessionDisconnect: "session:disconnect",
  SessionStartCashin: "session:start-cashin",
  SessionEndCashin: "session:end-cashin",
  SessionChange: "session:change",
  SessionStartReplenishEntrance: "session:start-replenish-entrance",
  SessionEndReplenishEntrance: "session:end-replenish-entrance",
  SessionLockUnit: "session:lock-unit",
  SessionUnlockUnit: "session:unlock-unit",
  SessionInventory: "session:inventory",
  SessionOpenExitCover: "session:open-exit-cover",
  SessionCloseExitCover: "session:close-exit-cover",
  LogLine: "log:line",
  EventReceived: "event:received",
} as const;
