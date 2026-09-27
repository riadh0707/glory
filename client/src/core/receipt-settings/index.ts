import * as fs from "fs";
import * as path from "path";

/**
 * Informations imprimées sur le ticket d'encaissement — propres à chaque
 * commerce qui achète le logiciel, donc modifiables sans recompiler.
 * Stockées dans `userData/receipt-settings.json`.
 */
export interface ReceiptSettings {
  companyName: string;
  /** Deuxième ligne d'en-tête : téléphone, n° TVA, adresse... */
  companyLine2: string;
  operatorName: string;
  footerMessage: string;
  /** Prochain numéro de ticket, incrémenté à chaque impression. */
  nextTicketNumber: number;
}

const DEFAULTS: ReceiptSettings = {
  companyName: "Mon commerce",
  companyLine2: "",
  operatorName: "",
  footerMessage: "Merci et à bientôt",
  nextTicketNumber: 1,
};

function filePath(userDataDir: string): string {
  return path.join(userDataDir, "receipt-settings.json");
}

export function loadReceiptSettings(userDataDir: string): ReceiptSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath(userDataDir), "utf8")) as Partial<ReceiptSettings>;
    return {
      companyName: stored.companyName ?? DEFAULTS.companyName,
      companyLine2: stored.companyLine2 ?? DEFAULTS.companyLine2,
      operatorName: stored.operatorName ?? DEFAULTS.operatorName,
      footerMessage: stored.footerMessage ?? DEFAULTS.footerMessage,
      nextTicketNumber: Number(stored.nextTicketNumber) > 0 ? Number(stored.nextTicketNumber) : DEFAULTS.nextTicketNumber,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveReceiptSettings(userDataDir: string, settings: ReceiptSettings): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(filePath(userDataDir), JSON.stringify(settings, null, 2), "utf8");
}

/** Renvoie le numéro à utiliser pour ce ticket et persiste le suivant. */
export function takeNextTicketNumber(userDataDir: string): number {
  const settings = loadReceiptSettings(userDataDir);
  const current = settings.nextTicketNumber;
  saveReceiptSettings(userDataDir, { ...settings, nextTicketNumber: current + 1 });
  return current;
}
