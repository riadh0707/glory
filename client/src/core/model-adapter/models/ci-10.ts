import { FccModelConfig } from "../types";

/**
 * CI-10 (ISP-K05/A/B/C) — famille RBW-100/RZ-50/RBG-200 + RCW-100/110.
 * Interface SOAP la mieux documentée du SDK (docs/models.md, IF Spec p.20).
 *
 * L'endpoint et le port ci-dessous correspondent à la VM simulateur du SDK,
 * vérifiés empiriquement le 2026-07-28 (voir docs/architecture.md, section
 * "Rôle de la VM") : firmware ISP-K05B Ver.18.30R1, HTTPS/443 (Axis2C),
 * certificat auto-signé. Pour un FCC physique CI-10, ces valeurs doivent être
 * reconfigurées avec l'IP/port réels du site (docs/open-questions.md : "Le
 * port du serveur SOAP du FCC... reste ouvert pour le matériel réel").
 */
export const ci10Config: FccModelConfig = {
  modelId: "CI-10",
  label: "CI-10 (ISP-K05/A/B/C), VM simulateur SDK",
  protocol: "soap",
  soapEndpoint: "https://192.168.0.25/axis2/services/BrueBoxService",
  tls: { rejectUnauthorized: false },
  // Port TCP observé dans le code d'exemple App/PosSimple pour le canal
  // événement brut (docs/event-system.md, section "Socket TCP brut") — non
  // garanti par l'IF Spec, à confirmer en pratique (docs/open-questions.md).
  eventListener: { mode: "tcp", tcpPort: 55561 },
  sourceNote: "docs/models.md § CI-10 ; docs/architecture.md § Rôle de la VM (vérifié 2026-07-28)",
};
