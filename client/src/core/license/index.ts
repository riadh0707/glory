/**
 * Licence (clé de produit) du logiciel.
 *
 * - Activation en ligne : la clé est envoyée au serveur de licences avec
 *   l'identifiant de ce PC ; le serveur lie la clé au PC et renvoie un jeton
 *   signé (Ed25519).
 * - Le jeton est vérifié ici avec la clé PUBLIQUE intégrée au logiciel : un
 *   jeton fabriqué, modifié ou copié depuis un autre PC est refusé.
 * - Hors connexion, le logiciel reste utilisable jusqu'à `refreshBy`
 *   (14 jours après le dernier contrôle réussi) ; il se renouvelle seul dès
 *   que le serveur est joignable.
 * - Une licence désactivée ou expirée côté serveur est retirée au contrôle
 *   suivant (au démarrage puis toutes les 6 h).
 */
import { createHash, createPublicKey, verify, KeyObject } from "crypto";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LICENSE_PUBLIC_KEY, LICENSE_SERVER_URL } from "./config";

export type LicenseState = "valid" | "none" | "invalid";

export interface LicenseStatus {
  state: LicenseState;
  /** Message lisible par l'utilisateur. */
  message: string;
  machineCode: string;
  client?: string;
  /** null = licence définitive. */
  expiresAt?: string | null;
  /** Date limite du prochain contrôle en ligne. */
  refreshBy?: string;
  /** Clé masquée (GFCC-XXXXX-•••••-•••••-XXXXX). */
  keyHint?: string;
}

interface TokenPayload {
  v: number;
  key: string;
  client: string;
  machineId: string;
  expiresAt: string | null;
  issuedAt: string;
  refreshBy: string;
}

interface Stored {
  key: string;
  token: string;
  /** Plus grande date vue par le logiciel : détecte une horloge reculée. */
  lastSeen: string;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;

/** Refus définitifs du serveur : la licence locale est retirée. */
const FINAL_REASONS = new Set(["unknown_key", "revoked", "expired", "not_activated", "seats_full"]);

function rawMachineId(): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out);
      if (m) return m[1].toLowerCase();
    } else {
      for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        if (fs.existsSync(f)) {
          const id = fs.readFileSync(f, "utf8").trim();
          if (id) return id;
        }
      }
    }
  } catch {
    /* repli ci-dessous */
  }
  // Repli : nom du PC + première adresse matérielle.
  const mac = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")?.mac;
  return `${os.hostname()}|${mac ?? ""}`;
}

export function machineCode(): string {
  const h = createHash("sha256").update(`glory-fcc|${rawMachineId()}`).digest("hex").toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}

function keyHint(key: string): string {
  const p = key.split("-");
  return p.length === 5 ? `${p[0]}-${p[1]}-•••••-•••••-${p[4]}` : "•••••";
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("fr-BE");

export class LicenseManager {
  private readonly file: string;
  private readonly machine = machineCode();
  private readonly publicKey: KeyObject;
  private stored: Stored | null = null;
  private lastStatus: LicenseStatus;

  constructor(
    dataDir: string,
    private readonly version: string,
    private readonly fetchFn: FetchFn,
    private readonly serverUrl = LICENSE_SERVER_URL
  ) {
    this.file = path.join(dataDir, "license.json");
    this.publicKey = createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY, "base64"), format: "der", type: "spki" });
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8")) as Stored;
      if (typeof s.key === "string" && typeof s.token === "string") this.stored = s;
    } catch {
      /* pas encore activé */
    }
    this.lastStatus = this.evaluate();
  }

  status(): LicenseStatus {
    this.lastStatus = this.evaluate();
    return this.lastStatus;
  }

  isLicensed(): boolean {
    return this.status().state === "valid";
  }

  /** Active une clé de produit (en ligne). */
  async activate(rawKey: string): Promise<LicenseStatus> {
    const key = String(rawKey ?? "").trim().toUpperCase().replace(/\s+/g, "");
    if (!/^GFCC(-[A-Z0-9]{5}){4}$/.test(key)) return this.fail("Format de clé invalide (GFCC-XXXXX-XXXXX-XXXXX-XXXXX).");
    const r = await this.call("/activate", { key, machineId: this.machine, machineName: os.hostname(), version: this.version });
    if (!r.ok) return this.fail(r.message);
    if (!this.accept(key, r.token)) return this.fail("Réponse du serveur de licences invalide.");
    return this.status();
  }

  /**
   * Contrôle en ligne. Hors connexion, la licence locale reste valable
   * jusqu'à sa date limite ; un refus définitif du serveur la retire.
   */
  async refresh(): Promise<LicenseStatus> {
    if (!this.stored) return this.status();
    const r = await this.call("/refresh", { key: this.stored.key, machineId: this.machine, version: this.version });
    if (r.ok) {
      this.accept(this.stored.key, r.token);
    } else if (r.reason && FINAL_REASONS.has(r.reason)) {
      this.clear();
      return this.fail(r.message);
    }
    return this.status();
  }

  /** Retire la licence de ce PC (pour saisir une autre clé). */
  clear(): void {
    this.stored = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* déjà absent */
    }
  }

  // ---------------------------------------------------------------- interne

  private fail(message: string): LicenseStatus {
    const s = this.evaluate();
    return s.state === "valid" ? { ...s, message } : { ...s, state: s.state === "none" ? "none" : "invalid", message };
  }

  private accept(key: string, token: unknown): boolean {
    if (typeof token !== "string" || !this.decode(token)) return false;
    this.stored = { key, token, lastSeen: new Date().toISOString() };
    this.save();
    return true;
  }

  private save(): void {
    if (!this.stored) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.stored), "utf8");
    } catch {
      /* la licence reste valable en mémoire */
    }
  }

  /** Jeton → contenu, seulement si la signature et le PC sont bons. */
  private decode(token: string): TokenPayload | null {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    try {
      if (!verify(null, Buffer.from(body), this.publicKey, Buffer.from(sig, "base64url"))) return null;
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
      return p.v === 1 && p.machineId === this.machine ? p : null;
    } catch {
      return null;
    }
  }

  private evaluate(): LicenseStatus {
    const base = { machineCode: this.machine };
    if (!this.stored) return { ...base, state: "none", message: "Aucune licence. Saisissez votre clé de produit." };
    const p = this.decode(this.stored.token);
    if (!p || p.key !== this.stored.key) return { ...base, state: "invalid", message: "Licence invalide pour ce PC. Saisissez votre clé de produit." };
    const info = { ...base, client: p.client, expiresAt: p.expiresAt, refreshBy: p.refreshBy, keyHint: keyHint(p.key) };
    const now = Date.now();
    // Horloge reculée de plus d'un jour : on exige un contrôle en ligne.
    if (now < Date.parse(this.stored.lastSeen) - 86400_000) {
      return { ...info, state: "invalid", message: "La date de ce PC semble incorrecte. Corrigez-la puis reconnectez-vous à internet." };
    }
    if (now > Date.parse(this.stored.lastSeen)) {
      this.stored.lastSeen = new Date(now).toISOString();
      this.save();
    }
    if (p.expiresAt && now > Date.parse(p.expiresAt)) {
      return { ...info, state: "invalid", message: `Licence expirée le ${fmtDate(p.expiresAt)}. Contactez votre fournisseur.` };
    }
    if (now > Date.parse(p.refreshBy)) {
      return { ...info, state: "invalid", message: "La licence n'a pas pu être vérifiée depuis plus de 14 jours. Connectez ce PC à internet." };
    }
    return { ...info, state: "valid", message: p.expiresAt ? `Licence valable jusqu'au ${fmtDate(p.expiresAt)}.` : "Licence définitive." };
  }

  private async call(route: string, body: object): Promise<{ ok: boolean; token?: unknown; reason?: string; message: string }> {
    try {
      const res = await this.fetchFn(this.serverUrl + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json()) as { ok?: boolean; token?: unknown; reason?: string; message?: string };
      return { ok: j.ok === true, token: j.token, reason: j.reason, message: j.message || "Refusé par le serveur de licences." };
    } catch {
      return { ok: false, reason: "network", message: "Serveur de licences injoignable. Vérifiez la connexion internet de ce PC." };
    }
  }
}
