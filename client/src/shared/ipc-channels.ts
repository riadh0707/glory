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
  SessionRomVersion: "session:rom-version",
  SessionAdjustTime: "session:adjust-time",
  SessionGetSettingFile: "session:get-setting-file",
  SessionEnableDenom: "session:enable-denom",
  SessionDisableDenom: "session:disable-denom",
  SessionSetExchangeRate: "session:set-exchange-rate",
  SessionReset: "session:reset",
  SessionCashinCancel: "session:cashin-cancel",
  SessionChangeCancel: "session:change-cancel",
  SessionReplenishEntranceCancel: "session:replenish-entrance-cancel",
  SessionCashout: "session:cashout",
  SessionReturnCash: "session:return-cash",
  DiagnosticGenerateReport: "diagnostic:generate-report",
  DiagnosticReportRendererError: "diagnostic:report-renderer-error",
  DiagnosticDayReport: "diagnostic:day-report",
  FccConfigGet: "fcc-config:get",
  FccConfigSave: "fcc-config:save",
  LogLine: "log:line",
  EventReceived: "event:received",
} as const;
