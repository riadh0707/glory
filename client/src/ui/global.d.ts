/**
 * Déclarations globales partagées entre les deux scripts renderer
 * (renderer.ts pour index.html, license.ts pour license.html — voir
 * tsconfig.renderer.json). Centralisées ici plutôt que dupliquées dans
 * chaque fichier : deux déclarations globales `interface Window { api: ... }`
 * incompatibles dans la même compilation TypeScript provoquent une erreur de
 * fusion de type (les deux fichiers sont compilés ensemble, sans système de
 * module — `api` doit donc avoir un seul type cohérent pour les deux pages).
 */
type SessionState = "Closed" | "Open" | "Occupied" | "Released";

interface TransactionResult {
  ok: boolean;
  message: string;
  state: SessionState;
  /** Montant encaissé en centimes, quand l'opération le connaît (Change,
   * EndCashin) — sert à imprimer le ticket. */
  amountCents?: number;
}

interface ReceiptSettings {
  companyName: string;
  companyLine2: string;
  operatorName: string;
  footerMessage: string;
  nextTicketNumber: number;
}

interface FccConnectionConfig {
  soapEndpoint: string;
  rejectUnauthorized: boolean;
  eventTcpPort: number;
  callbackIp: string;
  userId: string;
  userPwd: string;
}

interface DenomLine {
  cc: string;
  fv: string;
  devid: string;
  piece: number;
}

interface InventoryResponse {
  ok: boolean;
  message: string;
  raw?: unknown;
  lines?: DenomLine[];
  state: SessionState;
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

interface GloryClientApi {
  connect(): Promise<{ ok: boolean; message: string; state: SessionState }>;
  status(): Promise<{ ok: boolean; message: string; raw?: unknown; state: SessionState }>;
  disconnect(): Promise<{ ok: boolean; message: string; state: SessionState }>;
  startCashin(): Promise<TransactionResult>;
  endCashin(): Promise<TransactionResult>;
  change(amount: string): Promise<TransactionResult>;
  startReplenishEntrance(): Promise<TransactionResult>;
  endReplenishEntrance(): Promise<TransactionResult>;
  lockUnit(): Promise<TransactionResult>;
  unlockUnit(): Promise<TransactionResult>;
  inventory(): Promise<InventoryResponse>;
  openExitCover(): Promise<TransactionResult>;
  closeExitCover(): Promise<TransactionResult>;
  romVersion(): Promise<{ ok: boolean; message: string; raw?: unknown; state: SessionState }>;
  adjustTime(): Promise<TransactionResult>;
  getSettingFile(fileName: string): Promise<{ ok: boolean; message: string; raw?: unknown; state: SessionState }>;
  enableDenom(params: { cc: string; fv: string; devid: string }): Promise<TransactionResult>;
  disableDenom(params: { cc: string; fv: string; devid: string }): Promise<TransactionResult>;
  setExchangeRate(params: { from: string; to: string; rate: string }): Promise<TransactionResult>;
  reset(): Promise<TransactionResult>;
  cashinCancel(): Promise<TransactionResult>;
  changeCancel(): Promise<TransactionResult>;
  replenishEntranceCancel(): Promise<TransactionResult>;
  cashout(params: { cc: string; fv: string; devid: string; piece: number }): Promise<TransactionResult>;
  returnCash(): Promise<TransactionResult>;
  generateDiagnosticReport(): Promise<{ ok: boolean; message: string; jsonPath?: string; markdownPath?: string }>;
  reportRendererError(context: string, message: string, stack: string | undefined): Promise<void>;
  dayReport(): Promise<DayReportResponse>;
  receiptSettingsGet(): Promise<ReceiptSettings>;
  receiptSettingsSave(settings: ReceiptSettings): Promise<ReceiptSettings>;
  receiptTakeNumber(): Promise<number>;
  fccConfigGet(): Promise<FccConnectionConfig>;
  fccConfigSave(config: FccConnectionConfig): Promise<FccConnectionConfig>;
  onLogLine(callback: (line: string) => void): void;
  onEvent(callback: (line: string) => void): void;
}

interface Window {
  api: GloryClientApi;
}
