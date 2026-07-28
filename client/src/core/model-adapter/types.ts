/**
 * Types communs à tous les fichiers de config modèle.
 * Un modèle "confirmé" (CI-10, CI-10X, CI-50) utilise le protocole SOAP
 * documenté dans docs/soap-operations.md. CI-05 est représenté séparément
 * (voir ci-05.ts) car son protocole réel est ambigu — voir
 * docs/open-questions.md, question "WebSocket vs SOAP CI-5".
 */

export interface FccModelConfig {
  modelId: string;
  label: string;
  protocol: "soap";
  /** Endpoint SOAP réel du FCC. `null` si aucune valeur vérifiée n'est disponible
   * pour ce modèle — à fournir par configuration avant utilisation, ne jamais
   * deviner une IP de production. */
  soapEndpoint: string | null;
  tls: { rejectUnauthorized: boolean };
  /** Canal d'événements — voir docs/event-system.md pour le choix entre les deux
   * mécanismes officiellement supportés. */
  eventListener: { mode: "tcp"; tcpPort: number };
  sourceNote: string;
}

/** Modèle dont le protocole réel n'est pas confirmé par la documentation
 * disponible (voir docs/models.md, docs/open-questions.md). Point d'extension
 * volontairement non implémenté — ne pas deviner de comportement. */
export interface UnconfirmedModelConfig {
  modelId: string;
  label: string;
  status: "unconfirmed";
  sourceNote: string;
}

export type ModelConfig = FccModelConfig | UnconfirmedModelConfig;

export function isConfirmedModel(config: ModelConfig): config is FccModelConfig {
  return (config as FccModelConfig).protocol === "soap";
}
