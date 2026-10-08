import * as fs from "fs";
import * as path from "path";
import type { HistoryEventKind, HistoryEventRow } from "../history-store";

/**
 * Génère un rapport de diagnostic exploitable à partir de l'historique
 * enregistré par `HistoryStore` — pensé pour le test contre un FCC réel
 * (voir docs/development-notes.md, section correspondante) : le client peut
 * envoyer ce rapport dès qu'il rencontre un problème, sans avoir à décrire
 * lui-même la séquence d'appels ou à copier des logs depuis la console.
 *
 * Deux fichiers produits par appel, dans le même dossier horodaté :
 * - `report.json` : export brut de tous les événements (source de vérité,
 *   ré-analysable par script si besoin).
 * - `report.md` : résumé lisible par un humain — infos d'environnement,
 *   compteurs par opération/code résultat, liste chronologique des erreurs,
 *   puis le journal complet.
 */

export interface DiagnosticReportEnvironment {
  modelId: string;
  soapEndpoint: string | undefined;
  appStartedAt: string;
  reportGeneratedAt: string;
  platform: string;
  nodeVersion: string;
}

export interface DiagnosticReportResult {
  jsonPath: string;
  markdownPath: string;
  eventCount: number;
  errorCount: number;
}

/**
 * Les réponses SOAP sont enregistrées **brutes** dans `historyStore`
 * (`FccSoapClient.call()` journalise l'objet XML→JS tel que renvoyé par la
 * lib `soap`, avant que chaque méthode ne le retraite en `{result,
 * resultDescription}` — voir core/soap-client). L'attribut `result` y est
 * donc sous `attributes["n:result"]`/`attributes.result` (namespace Axis2C,
 * même particularité que `extractResultAttribute` dans soap-client), pas à
 * plat — reproduit ici pour que le résumé du rapport affiche les vrais
 * codes plutôt que "?" partout.
 */
function describeResultCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.result === "number" || typeof p.result === "string") return String(p.result);
  if (typeof p.resultDescription === "string") return p.resultDescription;
  const attrs = p.attributes as Record<string, unknown> | undefined;
  if (attrs) {
    const candidate = attrs["result"] ?? attrs["n:result"];
    if (candidate !== undefined) return String(candidate);
  }
  return undefined;
}

function buildSummary(events: HistoryEventRow[]): {
  countsByKind: Record<string, number>;
  countsByOperation: Record<string, { total: number; results: Record<string, number> }>;
  errors: HistoryEventRow[];
} {
  const countsByKind: Record<string, number> = {};
  const countsByOperation: Record<string, { total: number; results: Record<string, number> }> = {};
  const errors: HistoryEventRow[] = [];

  for (const ev of events) {
    countsByKind[ev.kind] = (countsByKind[ev.kind] ?? 0) + 1;

    if (ev.kind === "error") {
      errors.push(ev);
    }

    if (ev.kind === "soap-response" && ev.operation) {
      const entry = countsByOperation[ev.operation] ?? { total: 0, results: {} };
      entry.total += 1;
      const resultCode = describeResultCode(ev.payload) ?? "?";
      entry.results[resultCode] = (entry.results[resultCode] ?? 0) + 1;
      countsByOperation[ev.operation] = entry;
    }
  }

  return { countsByKind, countsByOperation, errors };
}

function formatMarkdown(env: DiagnosticReportEnvironment, events: HistoryEventRow[]): string {
  const { countsByKind, countsByOperation, errors } = buildSummary(events);
  const lines: string[] = [];

  lines.push("# Rapport de diagnostic : Glory FCC Client");
  lines.push("");
  lines.push("## Environnement");
  lines.push("");
  lines.push(`- Modèle : \`${env.modelId}\``);
  lines.push(`- Endpoint SOAP : \`${env.soapEndpoint ?? "(non configuré)"}\``);
  lines.push(`- App démarrée : ${env.appStartedAt}`);
  lines.push(`- Rapport généré : ${env.reportGeneratedAt}`);
  lines.push(`- Plateforme : ${env.platform}, Node ${env.nodeVersion}`);
  lines.push("");

  lines.push("## Résumé");
  lines.push("");
  lines.push(`- Total d'événements enregistrés : **${events.length}**`);
  lines.push(`- Erreurs : **${errors.length}**`);
  for (const [kind, count] of Object.entries(countsByKind)) {
    lines.push(`  - \`${kind}\` : ${count}`);
  }
  lines.push("");

  const opNames = Object.keys(countsByOperation).sort();
  if (opNames.length > 0) {
    lines.push("## Opérations SOAP appelées (code résultat → nombre d'occurrences)");
    lines.push("");
    lines.push("| Opération | Total | Codes résultat |");
    lines.push("|---|---|---|");
    for (const op of opNames) {
      const entry = countsByOperation[op];
      const resultsStr = Object.entries(entry.results)
        .map(([code, count]) => `${code}×${count}`)
        .join(", ");
      lines.push(`| \`${op}\` | ${entry.total} | ${resultsStr} |`);
    }
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push("## Erreurs (chronologique)");
    lines.push("");
    for (const err of errors) {
      lines.push(`- **${err.ts}** : ${JSON.stringify(err.payload)}`);
    }
    lines.push("");
  } else {
    lines.push("## Erreurs");
    lines.push("");
    lines.push("Aucune erreur enregistrée sur la période couverte par ce rapport.");
    lines.push("");
  }

  lines.push("## Journal complet (chronologique)");
  lines.push("");
  lines.push("```");
  for (const ev of events) {
    const opPart = ev.operation ? ` ${ev.operation}` : "";
    lines.push(`[${ev.ts}] ${ev.kind}${opPart} ${JSON.stringify(ev.payload)}`);
  }
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

/**
 * Écrit `report.json` (données brutes) et `report.md` (résumé lisible) dans
 * `outputDir/<horodatage>/`. `outputDir` doit déjà exister ou être créable
 * (créé récursivement ici si besoin).
 */
export function generateDiagnosticReport(
  outputDir: string,
  env: DiagnosticReportEnvironment,
  events: HistoryEventRow[]
): DiagnosticReportResult {
  const stamp = env.reportGeneratedAt.replace(/[:.]/g, "-");
  const dir = path.join(outputDir, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const jsonPath = path.join(dir, "report.json");
  const markdownPath = path.join(dir, "report.md");

  fs.writeFileSync(jsonPath, JSON.stringify({ environment: env, events }, null, 2), "utf8");
  fs.writeFileSync(markdownPath, formatMarkdown(env, events), "utf8");

  const errorCount = events.filter((e) => e.kind === ("error" as HistoryEventKind)).length;

  return { jsonPath, markdownPath, eventCount: events.length, errorCount };
}
