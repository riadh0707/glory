/**
 * Canaux IPC partagés entre le processus main et le preload. Toutes les
 * actions passent par `Call` (nom d'action + arguments, liste blanche et
 * droits vérifiés dans main.ts) ; les trois autres sont poussés par main.
 */
export const IpcChannels = {
  Call: "app:call",
  Log: "app:log",
  FccEvent: "app:fcc-event",
  State: "app:state",
} as const;
