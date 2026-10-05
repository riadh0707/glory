/**
 * Lecture des blocs `Cash` des réponses BrueBoxService.
 *
 * Chaque bloc porte un attribut `type` (IF Spec §7 "Cash Type Matrix",
 * p.238) qui change complètement son sens — les additionner sans regarder
 * le type faussait l'inventaire (stock total + distribuable comptés
 * ensemble) et le rapport du jour (argent reçu + monnaie rendue mélangés).
 */
export const CashType = {
  CashIn: 1,
  CashOut: 2,
  DeviceInventory: 3,
  Dispensable: 4,
  DenominationControl: 5,
  Payment: 6,
} as const;

export interface DenomLine {
  cc: string;
  /** Valeur faciale en centimes (IF Spec : "1=100"). */
  fv: string;
  /** 1 = module billets (RBW), 2 = module pièces (RCW). */
  devid: string;
  piece: number;
}

export interface CashBlock {
  type: number;
  lines: DenomLine[];
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: Record<string, unknown>, name: string): unknown {
  const attrs = (node.attributes as Record<string, unknown> | undefined) ?? {};
  return attrs[name] ?? attrs[`n:${name}`] ?? node[name];
}

function readDenominations(node: Record<string, unknown>): DenomLine[] {
  const out: DenomLine[] = [];
  for (const d of asArray(node.Denomination as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    if (!d || typeof d !== "object") continue;
    const piece = Number(d.Piece ?? 0) || 0;
    out.push({
      cc: String(attr(d, "cc") ?? "?"),
      fv: String(attr(d, "fv") ?? "0").trim(),
      devid: String(attr(d, "devid") ?? "?").trim(),
      piece,
    });
  }
  return out;
}

/** Tous les blocs `Cash` d'une réponse, avec leur type. */
export function parseCashBlocks(cash: unknown): CashBlock[] {
  return asArray(cash as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .filter((b) => b && typeof b === "object")
    .map((b) => ({ type: Number(attr(b, "type") ?? 0), lines: readDenominations(b) }));
}

/** Lignes d'un type donné uniquement (pièces > 0). */
export function linesOfType(cash: unknown, type: number): DenomLine[] {
  return parseCashBlocks(cash)
    .filter((b) => b.type === type)
    .flatMap((b) => b.lines)
    .filter((l) => l.piece > 0);
}

/**
 * Espèces reçues d'une réponse de fin de dépôt : bloc type 1 ("Cash in
 * information") s'il existe, sinon le premier bloc non vide — les réponses
 * EndCashin/EndReplenishment n'ont qu'un bloc utile mais tous les firmwares
 * ne renseignent pas l'attribut `type`.
 */
export function receivedLines(cash: unknown): DenomLine[] {
  const typed = linesOfType(cash, CashType.CashIn);
  if (typed.length > 0) return typed;
  const first = parseCashBlocks(cash).find((b) => b.type !== CashType.CashOut && b.lines.some((l) => l.piece > 0));
  return first ? first.lines.filter((l) => l.piece > 0) : [];
}

export function totalCents(lines: DenomLine[]): number {
  return lines.reduce((s, l) => s + l.piece * Number(l.fv), 0);
}

/**
 * Statut d'une unité tel que renvoyé par le terminal (`CashUnit@st`, IF
 * Spec p.75) — ce sont les seuils configurés dans la machine elle-même,
 * pas des seuils inventés côté client.
 */
export const UnitStatus = {
  Empty: 0,
  NearEmpty: 1,
  Exist: 2,
  NearFull: 3,
  Full: 4,
  Restrictive: 20,
  Missing: 21,
  NotAvailable: 22,
} as const;

export type UnitKind = "stacker" | "cassette" | "mixed" | "other";

export interface CashUnitInfo {
  devid: string;
  unitno: number;
  kind: UnitKind;
  status: number;
  nearFull: number;
  nearEmpty: number;
  max: number;
  lines: DenomLine[];
}

export interface InventorySnapshot {
  /** Contenu des modules de recyclage (Cash type=3). */
  device: DenomLine[];
  /** Ce qui peut être rendu en monnaie (Cash type=4). */
  dispensable: DenomLine[];
  /** Détail par unité physique (stackers, cassettes de collecte...). */
  units: CashUnitInfo[];
}

/** Numéros d'unité, IF Spec p.68-69 (RBW billets / RCW pièces). */
function unitKind(unitno: number): UnitKind {
  if (unitno >= 4043 && unitno <= 4055) return "stacker";
  if ((unitno >= 4056 && unitno <= 4060) || unitno === 4084) return "cassette";
  if (unitno === 4165) return "mixed";
  return "other";
}

/**
 * Inventaire structuré à partir d'une réponse `InventoryOperation`
 * (Option type=0 : Cash type 3 + Cash type 4 + CashUnits). Les vues sont
 * gardées séparées — les additionner comptait plusieurs fois les mêmes
 * billets (bug corrigé le 2026-10-05).
 */
export function parseInventory(raw: unknown): InventorySnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const device = linesOfType(r.Cash, CashType.DeviceInventory);
  const dispensable = linesOfType(r.Cash, CashType.Dispensable);
  const units: CashUnitInfo[] = [];
  for (const group of asArray(r.CashUnits as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    if (!group || typeof group !== "object") continue;
    const groupDevid = String(attr(group, "devid") ?? "?").trim();
    for (const unit of asArray(group.CashUnit as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      if (!unit || typeof unit !== "object") continue;
      const unitno = Number(String(attr(unit, "unitno") ?? "0").replace(/\s/g, ""));
      units.push({
        devid: groupDevid,
        unitno,
        kind: unitKind(unitno),
        status: Number(attr(unit, "st") ?? -1),
        nearFull: Number(attr(unit, "nf") ?? 0),
        nearEmpty: Number(attr(unit, "ne") ?? 0),
        max: Number(attr(unit, "max") ?? 0),
        lines: readDenominations(unit),
      });
    }
  }
  return { device, dispensable, units };
}

/**
 * Choisit les espèces à distribuer pour un montant exact, à partir du stock
 * distribuable. Recherche avec retour arrière (le glouton seul échoue sur
 * des cas réels, ex. 6 € avec 5 €×1 et 2 €×3) ; null si impossible.
 */
export function planPayout(amountCents: number, available: DenomLine[]): DenomLine[] | null {
  const stock = available.filter((l) => l.piece > 0 && Number(l.fv) > 0).sort((a, b) => Number(b.fv) - Number(a.fv));
  const take = new Array<number>(stock.length).fill(0);
  let steps = 0;
  function search(i: number, rest: number): boolean {
    if (rest === 0) return true;
    if (i >= stock.length || ++steps > 200_000) return false;
    const fv = Number(stock[i].fv);
    for (let n = Math.min(stock[i].piece, Math.floor(rest / fv)); n >= 0; n--) {
      take[i] = n;
      if (search(i + 1, rest - n * fv)) return true;
    }
    take[i] = 0;
    return false;
  }
  if (amountCents <= 0 || !search(0, amountCents)) return null;
  return stock.map((l, i) => ({ ...l, piece: take[i] })).filter((l) => l.piece > 0);
}

/**
 * Collecte en laissant un fond de caisse : on garde en priorité les petites
 * valeurs (utiles pour rendre la monnaie) jusqu'au montant demandé, et on
 * collecte le reste.
 */
export function planCollectKeepFloat(available: DenomLine[], floatCents: number): DenomLine[] {
  let rest = Math.max(0, floatCents);
  const out: DenomLine[] = [];
  for (const l of [...available].sort((a, b) => Number(a.fv) - Number(b.fv))) {
    const fv = Number(l.fv);
    const keep = fv > 0 ? Math.min(l.piece, Math.floor(rest / fv)) : l.piece;
    rest -= keep * fv;
    if (l.piece - keep > 0) out.push({ ...l, piece: l.piece - keep });
  }
  return out;
}

/** Regroupe par devise + valeur faciale (somme des modules). */
export function aggregate(lines: DenomLine[]): DenomLine[] {
  const map = new Map<string, DenomLine>();
  for (const l of lines) {
    const key = `${l.cc}|${l.fv}`;
    const cur = map.get(key) ?? { cc: l.cc, fv: l.fv, devid: l.devid, piece: 0 };
    cur.piece += l.piece;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => Number(b.fv) - Number(a.fv));
}
