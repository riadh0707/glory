import { UnconfirmedModelConfig } from "../types";

/**
 * CI-05 / CI-5 (ISP-K05F/G) — POINT D'EXTENSION VOLONTAIREMENT NON IMPLÉMENTÉ.
 *
 * docs/models.md et docs/open-questions.md documentent une contradiction non
 * résolue : l'IF Spec (p.20) place CI-5 sous la même interface SOAP que
 * CI-10/CI-10X/CI-50, mais les guides APG et des bibliothèques fermées
 * (FccWebsockLib.dll / FccInterfaceLib.jar) présentes dans le SDK suggèrent un
 * protocole WebSocket propriétaire distinct pour ce modèle, sans schéma
 * publié. Cette ambiguïté est explicitement listée comme question bloquante à
 * poser au constructeur Glory (docs/open-questions.md).
 *
 * Ce prototype ne code donc AUCUN comportement réseau pour CI-05 — ni SOAP ni
 * WebSocket — tant que cette question n'est pas tranchée. `getModelConfig`
 * retournera cette entrée avec `status: "unconfirmed"`, que l'appelant doit
 * gérer explicitement (voir core/model-adapter/index.ts).
 */
export const ci05Config: UnconfirmedModelConfig = {
  modelId: "CI-05",
  label: "CI-05 / CI-5 (ISP-K05F/G) — protocole non confirmé",
  status: "unconfirmed",
  sourceNote:
    "docs/models.md § CI-05 ; docs/open-questions.md § questions constructeur (ambiguïté SOAP/WebSocket)",
};
