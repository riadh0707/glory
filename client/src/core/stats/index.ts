import type { TransactionRow } from "../ledger";

export interface PeriodStats {
  fromIso: string;
  toIso: string;
  salesCount: number;
  /** Chiffre d'affaires espèces (somme des montants dus des ventes réussies). */
  salesCents: number;
  /** Espèces reçues des clients pour les ventes (avant rendu). */
  salesInCents: number;
  /** Monnaie rendue sur les ventes. */
  changeGivenCents: number;
  cancelledCount: number;
  depositsCents: number;
  payoutsCents: number;
  payoutsCount: number;
  refillsCents: number;
  collectsCents: number;
  exchangesCount: number;
  /** Variation théorique du contenu de la machine sur la période. */
  netMovementCents: number;
  averageSaleCents: number;
  byUser: Array<{ user: string; salesCount: number; salesCents: number }>;
  byHour: Array<{ hour: number; salesCount: number; salesCents: number }>;
}

export function computeStats(rows: TransactionRow[], fromIso: string, toIso: string): PeriodStats {
  const s: PeriodStats = {
    fromIso,
    toIso,
    salesCount: 0,
    salesCents: 0,
    salesInCents: 0,
    changeGivenCents: 0,
    cancelledCount: 0,
    depositsCents: 0,
    payoutsCents: 0,
    payoutsCount: 0,
    refillsCents: 0,
    collectsCents: 0,
    exchangesCount: 0,
    netMovementCents: 0,
    averageSaleCents: 0,
    byUser: [],
    byHour: [],
  };
  const users = new Map<string, { salesCount: number; salesCents: number }>();
  const hours = new Map<number, { salesCount: number; salesCents: number }>();

  for (const t of rows) {
    if (!t.ok) {
      if (t.kind === "cancel") s.cancelledCount += 1;
      continue;
    }
    // Toute opération réussie modifie le contenu de la machine de in - out.
    s.netMovementCents += t.inCents - t.outCents;
    switch (t.kind) {
      case "sale": {
        const due = t.dueCents ?? t.inCents - t.outCents;
        s.salesCount += 1;
        s.salesCents += due;
        s.salesInCents += t.inCents;
        s.changeGivenCents += t.outCents;
        const u = users.get(t.user) ?? { salesCount: 0, salesCents: 0 };
        u.salesCount += 1;
        u.salesCents += due;
        users.set(t.user, u);
        const h = new Date(t.ts).getHours();
        const hh = hours.get(h) ?? { salesCount: 0, salesCents: 0 };
        hh.salesCount += 1;
        hh.salesCents += due;
        hours.set(h, hh);
        break;
      }
      case "cancel":
        s.cancelledCount += 1;
        break;
      case "deposit":
        s.depositsCents += t.inCents;
        break;
      case "payout":
        s.payoutsCount += 1;
        s.payoutsCents += t.outCents;
        break;
      case "refill":
        s.refillsCents += t.inCents;
        break;
      case "collect":
        s.collectsCents += t.outCents;
        break;
      case "exchange":
        s.exchangesCount += 1;
        break;
    }
  }
  s.averageSaleCents = s.salesCount ? Math.round(s.salesCents / s.salesCount) : 0;
  s.byUser = [...users.entries()].map(([user, v]) => ({ user, ...v })).sort((a, b) => b.salesCents - a.salesCents);
  s.byHour = [...hours.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour - b.hour);
  return s;
}

/** Bornes ISO d'une journée locale (pas UTC : une vente à 1h du matin en Belgique reste sur le bon jour). */
export function localDayRange(dateYmd: string): { fromIso: string; toIso: string } {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const KIND_LABELS: Record<string, string> = {
  sale: "Vente",
  deposit: "Dépôt",
  payout: "Sortie d'espèces",
  refill: "Réapprovisionnement",
  collect: "Collecte",
  exchange: "Échange",
  cancel: "Annulation",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Export CSV (séparateur « ; » et décimales à virgule : s'ouvre tel quel dans Excel FR/BE). */
export function transactionsCsv(rows: TransactionRow[]): string {
  const euro = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));
  const head = ["N°", "Date", "Heure", "Type", "Utilisateur", "Montant dû", "Reçu", "Rendu/Sorti", "Statut", "Ticket", "Note"];
  const lines = rows.map((t) => {
    const d = new Date(t.ts);
    return [
      t.id,
      d.toLocaleDateString("fr-BE"),
      d.toLocaleTimeString("fr-BE"),
      kindLabel(t.kind),
      t.user,
      euro(t.dueCents),
      euro(t.inCents),
      euro(t.outCents),
      t.ok ? "OK" : "Échec",
      t.ticketNo ?? "",
      t.note ?? "",
    ]
      .map(csvCell)
      .join(";");
  });
  return "﻿" + [head.join(";"), ...lines].join("\r\n");
}
