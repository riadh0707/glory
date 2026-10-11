import * as fs from "fs";
import * as path from "path";

export interface AppSettings {
  /** Imprimer le ticket automatiquement après chaque vente réussie. */
  autoPrintReceipt: boolean;
  /** Fond de caisse à laisser dans la machine lors d'une collecte (centimes). */
  defaultFloatCents: number;
  /** Retour à l'écran de connexion après N minutes sans action (0 = jamais). */
  autoLockMinutes: number;
  /** Se connecter au terminal automatiquement à l'ouverture de session. */
  autoConnect: boolean;
  /** Fenêtre d'impression du système, ou ticket ouvert dans le navigateur par défaut. */
  printMethod: "system" | "browser";
  /**
   * Composition du fond de caisse à laisser lors d'une collecte : valeur
   * faciale en centimes → nombre (ex. { "2000": 1, "200": 10 }). Vide = on
   * utilise seulement le montant defaultFloatCents.
   */
  floatComposition: Record<string, number>;
  /** Codes-barres à prix intégré (étiquettes de balance). */
  scanEmbeddedPrice: boolean;
  /** Préfixes des codes à prix intégré, ex. « 21 22 23 24 ». */
  scanPricePrefixes: string;
}

const DEFAULTS: AppSettings = {
  autoPrintReceipt: false,
  defaultFloatCents: 20000,
  autoLockMinutes: 0,
  autoConnect: true,
  printMethod: "browser",
  floatComposition: {},
  scanEmbeddedPrice: true,
  scanPricePrefixes: "20 21 22 23 24 25 26 27 28 29",
};

/** Version des réglages : permet de corriger d'anciens réglages par défaut. */
const SETTINGS_VERSION = 2;

function file(dir: string): string {
  return path.join(dir, "app-settings.json");
}

export function loadAppSettings(dir: string): AppSettings {
  try {
    const s = JSON.parse(fs.readFileSync(file(dir), "utf8")) as Partial<AppSettings> & { settingsVersion?: number };
    const old = (s.settingsVersion ?? 1) < SETTINGS_VERSION;
    return {
      autoPrintReceipt: typeof s.autoPrintReceipt === "boolean" ? s.autoPrintReceipt : DEFAULTS.autoPrintReceipt,
      defaultFloatCents: Number.isFinite(s.defaultFloatCents) && (s.defaultFloatCents as number) >= 0 ? Math.round(s.defaultFloatCents as number) : DEFAULTS.defaultFloatCents,
      autoLockMinutes: Number.isFinite(s.autoLockMinutes) && (s.autoLockMinutes as number) >= 0 ? Math.round(s.autoLockMinutes as number) : DEFAULTS.autoLockMinutes,
      autoConnect: typeof s.autoConnect === "boolean" ? s.autoConnect : DEFAULTS.autoConnect,
      printMethod: cleanMethod(s.printMethod),
      floatComposition: cleanComposition(s.floatComposition),
      // v1.9.0 enregistrait « prix intégré : désactivé » par défaut, ce qui
      // empêchait les étiquettes du client de fonctionner : on le réactive une fois.
      scanEmbeddedPrice: old ? DEFAULTS.scanEmbeddedPrice : typeof s.scanEmbeddedPrice === "boolean" ? s.scanEmbeddedPrice : DEFAULTS.scanEmbeddedPrice,
      scanPricePrefixes: old ? DEFAULTS.scanPricePrefixes : typeof s.scanPricePrefixes === "string" ? cleanPrefixes(s.scanPricePrefixes) : DEFAULTS.scanPricePrefixes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppSettings(dir: string, s: AppSettings): AppSettings {
  fs.mkdirSync(dir, { recursive: true });
  const clean = loadAppSettingsFrom(s);
  fs.writeFileSync(file(dir), JSON.stringify({ ...clean, settingsVersion: SETTINGS_VERSION }, null, 2), "utf8");
  return clean;
}

function loadAppSettingsFrom(s: Partial<AppSettings>): AppSettings {
  return {
    autoPrintReceipt: !!s.autoPrintReceipt,
    defaultFloatCents: Math.max(0, Math.round(Number(s.defaultFloatCents) || 0)),
    autoLockMinutes: Math.max(0, Math.round(Number(s.autoLockMinutes) || 0)),
    autoConnect: s.autoConnect !== false,
    printMethod: cleanMethod(s.printMethod),
    floatComposition: cleanComposition(s.floatComposition),
    scanEmbeddedPrice: !!s.scanEmbeddedPrice,
    scanPricePrefixes: cleanPrefixes(s.scanPricePrefixes),
  };
}

const EURO_FACES = new Set([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]);

function cleanComposition(c: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (c && typeof c === "object") {
    for (const [fv, n] of Object.entries(c as Record<string, unknown>)) {
      const count = Math.round(Number(n));
      if (EURO_FACES.has(Number(fv)) && Number.isInteger(count) && count > 0 && count <= 5000) out[String(Number(fv))] = count;
    }
  }
  return out;
}

function cleanPrefixes(p: unknown): string {
  return String(p ?? "")
    .split(/[,;\s]+/)
    .filter((x) => /^\d{1,3}$/.test(x))
    .join(" ");
}

/** Montant total d'une composition de fond de caisse. */
export function compositionCents(c: Record<string, number>): number {
  return Object.entries(c).reduce((s, [fv, n]) => s + Number(fv) * n, 0);
}

function cleanMethod(m: unknown): AppSettings["printMethod"] {
  return m === "system" ? "system" : "browser";
}
