import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";

/**
 * Persistance locale SQLite via le module intégré `node:sqlite` (Node
 * 22.5+/Electron 43, aucune compilation native requise — voir bilan Étape 1 :
 * `better-sqlite3` a été écarté car sa compilation nécessite un toolchain
 * Visual C++ absent de cette machine, et aurait de toute façon dû être
 * recompilé pour l'ABI d'Electron).
 *
 * Ce sprint ne produit aucun TransactionId (aucune opération
 * StartCashin/Change/Collect n'est implémentée — hors périmètre explicite,
 * voir consigne du sprint), donc la table ne corrèle pas encore de
 * transactions métier. Elle enregistre dès maintenant un journal générique
 * (requêtes/réponses SOAP, transitions d'état, événements TCP bruts) : c'est
 * la base sur laquelle la corrélation de TransactionId
 * (docs/development-notes.md, piège n°4 : "le TransactionId n'est pas
 * toujours dans la réponse SOAP synchrone") viendra s'ajouter quand
 * StartCashin/Change seront implémentés.
 */
export type HistoryEventKind = "soap-request" | "soap-response" | "state-transition" | "raw-tcp-event";

export class HistoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        operation TEXT,
        payload TEXT NOT NULL
      )
    `);
  }

  record(kind: HistoryEventKind, operation: string | null, payload: unknown): void {
    const stmt = this.db.prepare(
      "INSERT INTO session_events (ts, kind, operation, payload) VALUES (?, ?, ?, ?)"
    );
    stmt.run(new Date().toISOString(), kind, operation, JSON.stringify(payload));
  }

  close(): void {
    this.db.close();
  }
}
