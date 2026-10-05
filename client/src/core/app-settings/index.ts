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
}

const DEFAULTS: AppSettings = {
  autoPrintReceipt: false,
  defaultFloatCents: 20000,
  autoLockMinutes: 0,
  autoConnect: true,
};

function file(dir: string): string {
  return path.join(dir, "app-settings.json");
}

export function loadAppSettings(dir: string): AppSettings {
  try {
    const s = JSON.parse(fs.readFileSync(file(dir), "utf8")) as Partial<AppSettings>;
    return {
      autoPrintReceipt: typeof s.autoPrintReceipt === "boolean" ? s.autoPrintReceipt : DEFAULTS.autoPrintReceipt,
      defaultFloatCents: Number.isFinite(s.defaultFloatCents) && (s.defaultFloatCents as number) >= 0 ? Math.round(s.defaultFloatCents as number) : DEFAULTS.defaultFloatCents,
      autoLockMinutes: Number.isFinite(s.autoLockMinutes) && (s.autoLockMinutes as number) >= 0 ? Math.round(s.autoLockMinutes as number) : DEFAULTS.autoLockMinutes,
      autoConnect: typeof s.autoConnect === "boolean" ? s.autoConnect : DEFAULTS.autoConnect,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppSettings(dir: string, s: AppSettings): AppSettings {
  fs.mkdirSync(dir, { recursive: true });
  const clean = loadAppSettingsFrom(s);
  fs.writeFileSync(file(dir), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

function loadAppSettingsFrom(s: Partial<AppSettings>): AppSettings {
  return {
    autoPrintReceipt: !!s.autoPrintReceipt,
    defaultFloatCents: Math.max(0, Math.round(Number(s.defaultFloatCents) || 0)),
    autoLockMinutes: Math.max(0, Math.round(Number(s.autoLockMinutes) || 0)),
    autoConnect: s.autoConnect !== false,
  };
}
