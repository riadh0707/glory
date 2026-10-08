import { DeviceErrorInfo } from "../device-errors";
import type { DenomLine } from "../cash";

/**
 * Décodage des événements poussés par le terminal sur le canal TCP
 * enregistré via RegisterEvent. Format observé sur le terminal du client
 * (rapport du 2026-09-07) : `<BbxEventRequest>…</BbxEventRequest>` suivi
 * d'un octet NUL, plusieurs trames pouvant arriver dans un même paquet TCP
 * ou une trame être coupée en deux — d'où `FrameSplitter`.
 */

/** `StatusChangeEvent/Status`, IF Spec §3.51.2 p.181-182. */
export const MACHINE_STATUS_LABELS: Record<number, string> = {
  0: "Initialisation",
  1: "Prêt",
  2: "Début de l'opération",
  3: "En attente des espèces",
  4: "Comptage en cours",
  5: "Rendu de monnaie en cours",
  6: "Retirez les billets refusés (entrée)",
  7: "Retirez les billets refusés (sortie)",
  8: "Réinitialisation",
  9: "Annulation en cours",
  10: "Calcul du rendu",
  11: "Annulation du dépôt",
  12: "Collecte en cours",
  13: "Erreur",
  14: "Mise à jour du firmware",
  15: "Lecture des journaux",
  16: "En attente du réapprovisionnement",
  17: "Comptage du réapprovisionnement",
  18: "Déverrouillage",
  19: "En attente de l'inventaire",
  20: "Montant de dépôt fixé",
  21: "Montant de distribution fixé",
  22: "En attente de distribution",
  23: "En attente d'annulation",
  24: "Billet suspect (catégorie 2) compté",
  25: "En attente de fin de dépôt",
  26: "Retirez la cassette COFT",
  27: "Scellage",
  30: "En attente de résolution d'erreur",
  40: "Terminal occupé",
  41: "En attente de mise à jour",
};

/** Événements d'unité (GlyCashierEvent, IF Spec §3.58). */
const UNIT_EVENT_LABELS: Record<string, string> = {
  eventEmpty: "vide",
  eventLow: "presque vide",
  eventExist: "niveau normal",
  eventHigh: "presque plein",
  eventFull: "plein",
  eventMissing: "cassette absente",
  eventOpened: "ouvert",
  eventClosed: "fermé",
  eventLocked: "verrouillé",
  eventWaitForOpening: "en attente d'ouverture",
  eventWaitForRemoving: "retirez les espèces",
  eventWaitforRemoving: "retirez les espèces",
  eventRemoved: "espèces retirées",
  eventCassetteInserted: "cassette insérée",
  eventCassetteChecked: "cassette vérifiée",
  eventWaitForInsertion: "en attente d'insertion",
};

export type FccEvent =
  | { kind: "heartbeat" }
  | { kind: "status"; status: number; label: string; amountCents: number; error: number }
  | { kind: "deposit"; devid: string; lines: DenomLine[] }
  | { kind: "unit"; devid: string; name: string; label: string }
  | { kind: "device-status"; devid: string; statusId: number }
  | { kind: "error"; devid: string; code: number; recoveryUrl: string; info?: DeviceErrorInfo }
  | { kind: "response"; name: string; result: number | null }
  | { kind: "other"; name: string };

export class FrameSplitter {
  private buffer = "";

  /** Ajoute un morceau reçu, renvoie les trames complètes. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\0");
    this.buffer = parts.pop() ?? "";
    // Garde-fou : une trame sans terminateur ne doit pas grossir sans fin.
    if (this.buffer.length > 1_000_000) this.buffer = "";
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  }
}

function tagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function attrOf(openTag: string, name: string): string | null {
  const m = openTag.match(new RegExp(`\\b${name}\\s*=\\s*"\\s*([^"]*?)\\s*"`));
  return m ? m[1].replace(/\s/g, "") : null;
}

function parseDenominations(xml: string): DenomLine[] {
  const out: DenomLine[] = [];
  const re = /<Denomination\b([^>]*)>([\s\S]*?)<\/Denomination>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push({
      cc: attrOf(m[1], "cc") ?? "?",
      fv: attrOf(m[1], "fv") ?? "0",
      devid: attrOf(m[1], "devid") ?? "?",
      piece: Number(tagText(m[2], "Piece") ?? 0) || 0,
    });
  }
  return out;
}

export function parseFrame(frame: string): FccEvent {
  const inner = frame.replace(/^[\s\S]*?<BbxEventRequest[^>]*>/, "").replace(/<\/BbxEventRequest>[\s\S]*$/, "");
  const first = inner.match(/<([A-Za-z][\w]*)\b([^>]*)>/);
  if (!first) return { kind: "other", name: "?" };
  const [, name, openAttrs] = first;

  if (name === "HeartBeatEvent") return { kind: "heartbeat" };

  if (name === "StatusChangeEvent") {
    const status = Number(tagText(inner, "Status") ?? -1);
    return {
      kind: "status",
      status,
      label: MACHINE_STATUS_LABELS[status] ?? `État ${status}`,
      amountCents: Number(tagText(inner, "Amount") ?? 0) || 0,
      error: Number(tagText(inner, "Error") ?? 0) || 0,
    };
  }

  if (name === "GlyCashierEvent") {
    const devid = attrOf(openAttrs, "devid") ?? "?";
    const sub = inner.replace(/^[\s\S]*?<GlyCashierEvent[^>]*>/, "").match(/<([A-Za-z][\w]*)\b/);
    const subName = sub ? sub[1] : "?";
    if (subName === "eventDepositCountChange" || subName === "eventDepositCountMonitor") {
      return { kind: "deposit", devid, lines: parseDenominations(inner) };
    }
    if (subName === "eventStatusChange") {
      return { kind: "device-status", devid, statusId: Number(tagText(inner, "DeviceStatusID") ?? -1) };
    }
    if (subName === "eventError") {
      // <eventError><ErrorCode>1281</ErrorCode><RecoveryURL>http://…/help/…gif</RecoveryURL></eventError>
      return { kind: "error", devid, code: Number(tagText(inner, "ErrorCode") ?? 0) || 0, recoveryUrl: (tagText(inner, "RecoveryURL") ?? "").trim() };
    }
    if (UNIT_EVENT_LABELS[subName]) {
      return { kind: "unit", devid, name: subName, label: UNIT_EVENT_LABELS[subName] };
    }
    return { kind: "other", name: subName };
  }

  if (name.endsWith("Response")) {
    const r = attrOf(openAttrs, "result");
    return { kind: "response", name, result: r === null ? null : Number(r) };
  }
  return { kind: "other", name };
}
