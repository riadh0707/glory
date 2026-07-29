import axios from "axios";
import * as fs from "fs";
import * as path from "path";

/**
 * Vérification de licence en ligne — le client Electron doit contacter le
 * serveur de licence (Cloudflare Worker, voir `license-server/`) à **chaque
 * lancement** avant d'autoriser l'usage de l'application. Pas de mode
 * hors-ligne / grâce : si le serveur est injoignable, l'accès est refusé
 * (choix explicite du client, voir docs/development-notes.md).
 */

export interface LicenseRecord {
  key: string;
  clientName: string | null;
  expiresAt: string | null;
  /** Dernière vérification en ligne réussie — informatif uniquement, ne
   * sert jamais à contourner la vérification en ligne du lancement suivant. */
  lastVerifiedAt: string;
}

export type LicenseCheckResult =
  | { status: "valid"; record: LicenseRecord }
  | { status: "invalid"; reason: "unknown_key" | "revoked" | "expired" | "malformed_request"; expiresAt?: string }
  | { status: "network-error"; message: string };

function licenseFilePath(userDataDir: string): string {
  return path.join(userDataDir, "license.json");
}

export function readStoredLicense(userDataDir: string): LicenseRecord | null {
  try {
    const raw = fs.readFileSync(licenseFilePath(userDataDir), "utf8");
    return JSON.parse(raw) as LicenseRecord;
  } catch {
    return null;
  }
}

function writeStoredLicense(userDataDir: string, record: LicenseRecord): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(licenseFilePath(userDataDir), JSON.stringify(record, null, 2), "utf8");
}

export function clearStoredLicense(userDataDir: string): void {
  try {
    fs.unlinkSync(licenseFilePath(userDataDir));
  } catch {
    // Rien à faire si le fichier n'existe déjà pas.
  }
}

/**
 * Appelle `POST {serverUrl}/verify` avec la clé fournie. `serverUrl` est
 * l'URL du Worker (ex. `https://glory-fcc-license-server.<compte>.workers.dev`),
 * configurable — voir `LICENSE_SERVER_URL` dans main.ts.
 */
async function callVerifyEndpoint(
  serverUrl: string,
  key: string
): Promise<{ valid: boolean; reason?: string; expiresAt?: string; clientName?: string | null }> {
  const url = new URL("/verify", serverUrl);
  // axios (plutôt que le module `https` seul) gère aussi bien http:// que
  // https:// sans code séparé pour chaque protocole — utile pour pointer
  // vers un Worker local (`wrangler dev`, http://127.0.0.1:8787) en
  // développement sans changer de logique de requête pour la prod (https).
  const response = await axios.post(
    url.toString(),
    { key },
    { timeout: 15_000, validateStatus: () => true }
  );
  return response.data;
}

/**
 * Vérifie une clé de licence en ligne et, si valide, la persiste dans
 * `userDataDir/license.json` (remplace toute licence précédemment stockée).
 */
export async function verifyAndStoreLicense(
  serverUrl: string,
  userDataDir: string,
  key: string
): Promise<LicenseCheckResult> {
  let response;
  try {
    response = await callVerifyEndpoint(serverUrl, key);
  } catch (err) {
    return { status: "network-error", message: err instanceof Error ? err.message : String(err) };
  }

  if (!response.valid) {
    return {
      status: "invalid",
      reason: (response.reason as "unknown_key" | "revoked" | "expired" | "malformed_request") ?? "unknown_key",
      expiresAt: response.expiresAt,
    };
  }

  const record: LicenseRecord = {
    key,
    clientName: response.clientName ?? null,
    expiresAt: response.expiresAt ?? null,
    lastVerifiedAt: new Date().toISOString(),
  };
  writeStoredLicense(userDataDir, record);
  return { status: "valid", record };
}

/**
 * Revérifie en ligne la licence déjà stockée localement (appelé à chaque
 * démarrage de l'app). Si aucune licence n'est stockée, renvoie
 * `{status:"invalid", reason:"unknown_key"}` sans appeler le réseau —
 * l'appelant doit alors présenter l'écran d'activation.
 */
export async function recheckStoredLicense(serverUrl: string, userDataDir: string): Promise<LicenseCheckResult> {
  const stored = readStoredLicense(userDataDir);
  if (!stored) {
    return { status: "invalid", reason: "unknown_key" };
  }
  return verifyAndStoreLicense(serverUrl, userDataDir, stored.key);
}
