import { FccModelConfig } from "../types";

/**
 * CI-10X (ISP-K05H) — famille RBW-200/RCW-200 (docs/models.md § CI-10X,
 * IF Spec p.20). Même interface SOAP que CI-10, mais aucune VM/instance
 * vérifiée pour ce modèle dans ce SDK — endpoint volontairement laissé à
 * `null` : à renseigner via configuration avant utilisation, ne pas deviner
 * une adresse.
 */
export const ci10xConfig: FccModelConfig = {
  modelId: "CI-10X",
  label: "CI-10X (ISP-K05H)",
  protocol: "soap",
  soapEndpoint: null,
  tls: { rejectUnauthorized: false },
  eventListener: { mode: "tcp", tcpPort: 55561 },
  sourceNote: "docs/models.md § CI-10X — endpoint non vérifié, à configurer par environnement",
};
