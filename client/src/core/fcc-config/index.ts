import * as fs from "fs";
import * as path from "path";

/**
 * Configuration de connexion au FCC, modifiable par le client **sans
 * recompiler l'app** — nécessaire car `core/model-adapter/models/ci-10.ts`
 * pointe par défaut vers la VM simulateur du SDK (192.168.0.25), jamais
 * l'adresse du matériel réel d'un client donné (voir sa docstring). Stockée
 * dans `userData/fcc-config.json`, éditable soit via le champ "Adresse du
 * FCC" de l'écran principal (sauvegardée automatiquement à la connexion),
 * soit directement à la main dans ce fichier JSON.
 */
export interface FccConnectionConfig {
  /** URL complète du service SOAP, ex. "https://192.168.1.50/axis2/services/BrueBoxService". */
  soapEndpoint: string;
  /** false si le FCC présente un certificat auto-signé (cas le plus
   * courant en pratique, y compris sur du matériel réel non reconfiguré
   * avec un certificat signé par une autorité de confiance). */
  rejectUnauthorized: boolean;
  /** Port TCP local sur lequel la caisse écoute les événements poussés par
   * le FCC (voir docs/event-system.md) — rarement à changer. */
  eventTcpPort: number;
  /**
   * Adresse IP de **cette machine** (la caisse), telle que joignable depuis
   * le FCC sur le même réseau — c'est l'adresse que le FCC utilise pour
   * ouvrir la connexion TCP retour des événements (`RegisterEvent`,
   * paramètre `Url`). **`127.0.0.1` ne fonctionne jamais** : le FCC est
   * toujours une machine distincte, même en réseau local — voir la
   * docstring historique dans `main.ts`. Doit être l'IP de la caisse sur le
   * même sous-réseau/VLAN que le FCC (à demander à l'administrateur réseau
   * du site si elle n'est pas déjà connue).
   */
  callbackIp: string;
}

function configFilePath(userDataDir: string): string {
  return path.join(userDataDir, "fcc-config.json");
}

export function loadFccConfig(userDataDir: string, defaults: FccConnectionConfig): FccConnectionConfig {
  try {
    const raw = fs.readFileSync(configFilePath(userDataDir), "utf8");
    const stored = JSON.parse(raw) as Partial<FccConnectionConfig>;
    return {
      soapEndpoint: stored.soapEndpoint || defaults.soapEndpoint,
      rejectUnauthorized: stored.rejectUnauthorized ?? defaults.rejectUnauthorized,
      eventTcpPort: stored.eventTcpPort || defaults.eventTcpPort,
      callbackIp: stored.callbackIp || defaults.callbackIp,
    };
  } catch {
    return defaults;
  }
}

export function saveFccConfig(userDataDir: string, config: FccConnectionConfig): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(configFilePath(userDataDir), JSON.stringify(config, null, 2), "utf8");
}
