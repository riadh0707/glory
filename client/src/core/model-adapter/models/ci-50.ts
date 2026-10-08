import { FccModelConfig } from "../types";

/**
 * CI-50 (ISP-K05D/E) — famille RBW-150 + RCW-100/110 (docs/models.md § CI-50,
 * IF Spec p.20). Même interface SOAP que CI-10, mais aucune VM/instance
 * vérifiée pour ce modèle dans ce SDK — endpoint volontairement laissé à
 * `null` : à renseigner via configuration avant utilisation, ne pas deviner
 * une adresse.
 */
export const ci50Config: FccModelConfig = {
  modelId: "CI-50",
  label: "CI-50 (ISP-K05D/E)",
  protocol: "soap",
  soapEndpoint: null,
  tls: { rejectUnauthorized: false },
  eventListener: { mode: "tcp", tcpPort: 55561 },
  sourceNote: "docs/models.md § CI-50 : endpoint non vérifié, à configurer par environnement",
};
