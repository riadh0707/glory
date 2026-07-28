import { ModelConfig, isConfirmedModel } from "./types";
import { ci10Config } from "./models/ci-10";
import { ci10xConfig } from "./models/ci-10x";
import { ci50Config } from "./models/ci-50";
import { ci05Config } from "./models/ci-05";

export { ModelConfig, FccModelConfig, UnconfirmedModelConfig, isConfirmedModel } from "./types";

const registry: Record<string, ModelConfig> = {
  "CI-10": ci10Config,
  "CI-10X": ci10xConfig,
  "CI-50": ci50Config,
  "CI-05": ci05Config,
};

export function getModelConfig(modelId: string): ModelConfig {
  const config = registry[modelId];
  if (!config) {
    throw new Error(
      `Modèle "${modelId}" inconnu de core/model-adapter. Modèles disponibles : ${Object.keys(registry).join(", ")}`
    );
  }
  return config;
}

export function listModels(): ModelConfig[] {
  return Object.values(registry);
}
