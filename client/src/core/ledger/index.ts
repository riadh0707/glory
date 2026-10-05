import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import type { DenomLine } from "../cash";

/**
 * Journal métier des opérations de caisse — distinct de `HistoryStore`
 * (journal technique SOAP pour le diagnostic). C'est la source de
 * l'historique, des statistiques et de la clôture de caisse.
 */
export type TransactionKind =
  | "sale" // vente : encaissement avec rendu (ChangeOperation)
  | "deposit" // dépôt libre (StartCashin/EndCashin)
  | "payout" // sortie d'espèces / remboursement (Cashout)
  | "refill" // réapprovisionnement
  | "collect" // collecte vers cassette
  | "exchange" // échange de monnaie
  | "cancel"; // dépôt annulé et restitué

export interface TransactionInput {
  kind: TransactionKind;
  user: string;
  dueCents?: number | null;
  inCents: number;
  outCents: number;
  ok: boolean;
  result?: number | null;
  ticketNo?: number | null;
  inLines?: DenomLine[];
  outLines?: DenomLine[];
  note?: string;
}

export interface TransactionRow extends TransactionInput {
  id: number;
  ts: string;
}

export type SnapshotKind = "open" | "close" | "manual";

export interface SnapshotRow {
  id: number;
  ts: string;
  kind: SnapshotKind;
  user: string;
  totalCents: number;
  lines: DenomLine[];
}

export class Ledger {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        user TEXT NOT NULL,
        due_cents INTEGER,
        in_cents INTEGER NOT NULL,
        out_cents INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        result INTEGER,
        ticket_no INTEGER,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_ts ON transactions(ts);
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        user TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        lines TEXT NOT NULL
      );
    `);
  }

  add(t: TransactionInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO transactions (ts, kind, user, due_cents, in_cents, out_cents, ok, result, ticket_no, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        t.kind,
        t.user,
        t.dueCents ?? null,
        t.inCents,
        t.outCents,
        t.ok ? 1 : 0,
        t.result ?? null,
        t.ticketNo ?? null,
        JSON.stringify({ inLines: t.inLines ?? [], outLines: t.outLines ?? [], note: t.note ?? "" })
      );
    return Number(info.lastInsertRowid);
  }

  setTicket(id: number, ticketNo: number): void {
    this.db.prepare("UPDATE transactions SET ticket_no = ? WHERE id = ?").run(ticketNo, id);
  }

  /** Transactions entre deux instants ISO (bornes incluses/exclues). */
  list(fromIso: string, toIso: string): TransactionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM transactions WHERE ts >= ? AND ts < ? ORDER BY id DESC")
      .all(fromIso, toIso) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const details = JSON.parse(String(r.details ?? "{}")) as {
        inLines?: DenomLine[];
        outLines?: DenomLine[];
        note?: string;
      };
      return {
        id: Number(r.id),
        ts: String(r.ts),
        kind: r.kind as TransactionKind,
        user: String(r.user),
        dueCents: r.due_cents === null ? null : Number(r.due_cents),
        inCents: Number(r.in_cents),
        outCents: Number(r.out_cents),
        ok: Number(r.ok) === 1,
        result: r.result === null ? null : Number(r.result),
        ticketNo: r.ticket_no === null ? null : Number(r.ticket_no),
        inLines: details.inLines ?? [],
        outLines: details.outLines ?? [],
        note: details.note ?? "",
      };
    });
  }

  addSnapshot(kind: SnapshotKind, user: string, lines: DenomLine[], totalCents: number): void {
    this.db
      .prepare("INSERT INTO snapshots (ts, kind, user, total_cents, lines) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, user, totalCents, JSON.stringify(lines));
  }

  /** Dernier relevé d'un type donné avant un instant. */
  lastSnapshot(kind: SnapshotKind, beforeIso: string): SnapshotRow | null {
    const r = this.db
      .prepare("SELECT * FROM snapshots WHERE kind = ? AND ts < ? ORDER BY id DESC LIMIT 1")
      .get(kind, beforeIso) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      ts: String(r.ts),
      kind: r.kind as SnapshotKind,
      user: String(r.user),
      totalCents: Number(r.total_cents),
      lines: JSON.parse(String(r.lines)) as DenomLine[],
    };
  }

  close(): void {
    this.db.close();
  }
}
