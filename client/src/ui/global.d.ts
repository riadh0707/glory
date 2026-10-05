/**
 * Types partagés par les scripts de l'interface (compilés ensemble, sans
 * système de modules — voir tsconfig.renderer.json). Ils reflètent ce que
 * renvoient les actions de src/main/main.ts.
 */

type Role = "admin" | "vendeur";

interface PublicUser {
  name: string;
  role: Role;
}

interface DenomLine {
  cc: string;
  fv: string;
  devid: string;
  piece: number;
}

interface OpResult {
  ok: boolean;
  message: string;
  result?: number;
}

interface MoneyResult extends OpResult {
  dueCents?: number;
  inCents: number;
  outCents: number;
  inLines: DenomLine[];
  outLines: DenomLine[];
  transactionId?: number;
}

interface CashUnitInfo {
  devid: string;
  unitno: number;
  kind: "stacker" | "cassette" | "mixed" | "other";
  status: number;
  nearFull: number;
  nearEmpty: number;
  max: number;
  lines: DenomLine[];
}

interface InventorySnapshot {
  device: DenomLine[];
  dispensable: DenomLine[];
  units: CashUnitInfo[];
}

type FccEvent =
  | { kind: "heartbeat" }
  | { kind: "status"; status: number; label: string; amountCents: number; error: number }
  | { kind: "deposit"; devid: string; lines: DenomLine[] }
  | { kind: "unit"; devid: string; name: string; label: string }
  | { kind: "device-status"; devid: string; statusId: number }
  | { kind: "error"; devid: string; detail: string }
  | { kind: "response"; name: string; result: number | null }
  | { kind: "other"; name: string };

interface CashierState {
  connection: "disconnected" | "connecting" | "connected";
  sessionMode: boolean;
  occupyMode: boolean;
  busy: string | null;
}

interface FccConnectionConfig {
  soapEndpoint: string;
  rejectUnauthorized: boolean;
  eventTcpPort: number;
  callbackIp: string;
  userId: string;
  userPwd: string;
}

interface ReceiptSettings {
  companyName: string;
  companyLine2: string;
  operatorName: string;
  footerMessage: string;
  paperFormat: "58mm" | "80mm" | "A4";
  nextTicketNumber: number;
}

interface AppSettings {
  autoPrintReceipt: boolean;
  defaultFloatCents: number;
  autoLockMinutes: number;
  autoConnect: boolean;
}

type TransactionKind = "sale" | "deposit" | "payout" | "refill" | "collect" | "exchange" | "cancel";

interface TransactionRow {
  id: number;
  ts: string;
  kind: TransactionKind;
  user: string;
  dueCents: number | null;
  inCents: number;
  outCents: number;
  ok: boolean;
  result: number | null;
  ticketNo: number | null;
  inLines: DenomLine[];
  outLines: DenomLine[];
  note: string;
}

interface PeriodStats {
  fromIso: string;
  toIso: string;
  salesCount: number;
  salesCents: number;
  salesInCents: number;
  changeGivenCents: number;
  cancelledCount: number;
  depositsCents: number;
  payoutsCents: number;
  payoutsCount: number;
  refillsCents: number;
  collectsCents: number;
  exchangesCount: number;
  netMovementCents: number;
  averageSaleCents: number;
  byUser: Array<{ user: string; salesCount: number; salesCents: number }>;
  byHour: Array<{ hour: number; salesCount: number; salesCents: number }>;
}

interface GloryApi {
  call<T = OpResult>(action: string, ...args: unknown[]): Promise<T>;
  onLog(cb: (line: string) => void): void;
  onFccEvent(cb: (e: FccEvent) => void): void;
  onState(cb: (s: CashierState) => void): void;
}

interface Window {
  api: GloryApi;
}
