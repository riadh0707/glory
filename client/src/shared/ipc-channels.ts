/**
 * Noms des canaux IPC partagés entre le processus main et le preload.
 * Fichier séparé pour éviter de dupliquer les chaînes littérales des deux côtés
 * du pont contextBridge (source d'erreurs classiques si elles divergent).
 */
export const IpcChannels = {
  SessionConnect: "session:connect",
  SessionStatus: "session:status",
  SessionDisconnect: "session:disconnect",
  LogLine: "log:line",
  EventReceived: "event:received",
} as const;
