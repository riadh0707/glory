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
/**
 * Ajout (2026-07-29) : `error` et `app-lifecycle`, nécessaires pour le
 * rapport de diagnostic — voir `core/diagnostic-report`. `error` capture
 * toute erreur remontée au client (échec SOAP catché, exception non prévue,
 * erreur renderer) ; `app-lifecycle` capture démarrage/arrêt de l'app avec
 * le contexte d'environnement (endpoint, modèle) pour savoir *contre quoi*
 * un test a été fait sans avoir à le redemander au client.
 */
export type HistoryEventKind =
  | "soap-request"
  | "soap-response"
  | "state-transition"
  | "raw-tcp-event"
  | "error"
  | "app-lifecycle";

export interface HistoryEventRow {
  id: number;
  ts: string;
  kind: HistoryEventKind;
  operation: string | null;
  payload: unknown;
}

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

  /**
   * Toutes les lignes depuis `sinceId` (exclu), triées chronologiquement —
   * base du rapport de diagnostic. `sinceId=0` (défaut) renvoie tout
   * l'historique enregistré (potentiellement plusieurs lancements de l'app,
   * la base SQLite persiste sur disque entre les sessions).
   */
  getAllEvents(sinceId = 0): HistoryEventRow[] {
    const stmt = this.db.prepare(
      "SELECT id, ts, kind, operation, payload FROM session_events WHERE id > ? ORDER BY id ASC"
    );
    const rows = stmt.all(sinceId) as Array<{
      id: number;
      ts: string;
      kind: string;
      operation: string | null;
      payload: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind as HistoryEventKind,
      operation: r.operation,
      payload: JSON.parse(r.payload),
    }));
  }

  close(): void {
    this.db.close();
  }
}
