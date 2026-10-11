/**
 * Catalogue d'articles : code-barres → nom + prix. Stocké dans
 * userData/products.json (quelques milliers d'articles restent instantanés).
 */
import * as fs from "fs";
import * as path from "path";

export interface Product {
  /** Code-barres tel que lu par le scanner (EAN-13, EAN-8, UPC, Code 128…). */
  code: string;
  name: string;
  priceCents: number;
}

/** Article d'une vente (panier). `code` vide = montant libre saisi au pavé. */
export interface SaleItem {
  code: string;
  name: string;
  priceCents: number;
  qty: number;
}

const CODE_RE = /^[A-Za-z0-9\-.$/+%]{1,48}$/;

export function cleanCode(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, "");
}

export function cleanItems(raw: unknown): SaleItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 500)
    .map((i: Record<string, unknown>) => ({
      code: cleanCode(i?.code).slice(0, 48),
      name: String(i?.name ?? "").slice(0, 120),
      priceCents: Math.round(Number(i?.priceCents)),
      qty: Math.round(Number(i?.qty)),
    }))
    .filter((i) => Number.isInteger(i.priceCents) && i.priceCents >= 0 && Number.isInteger(i.qty) && i.qty > 0 && i.qty <= 9999);
}

export function itemsTotal(items: SaleItem[]): number {
  return items.reduce((s, i) => s + i.priceCents * i.qty, 0);
}

export class ProductStore {
  private readonly file: string;
  private items = new Map<string, Product>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "products.json");
    try {
      const list = JSON.parse(fs.readFileSync(this.file, "utf8")) as Product[];
      for (const p of list) if (p && CODE_RE.test(p.code)) this.items.set(p.code, p);
    } catch {
      /* pas encore de catalogue */
    }
  }

  list(): Product[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  find(code: string): Product | null {
    return this.items.get(cleanCode(code)) ?? null;
  }

  save(p: Product, previousCode?: string): Product {
    const clean = this.validate(p);
    if (previousCode && previousCode !== clean.code) this.items.delete(cleanCode(previousCode));
    this.items.set(clean.code, clean);
    this.persist();
    return clean;
  }

  remove(code: string): void {
    this.items.delete(cleanCode(code));
    this.persist();
  }

  /**
   * Import d'un fichier CSV « code;nom;prix » (séparateur ; ou , ou tabulation,
   * prix en euros « 2,50 » ou « 2.50 », ligne d'en-tête facultative).
   */
  importCsv(text: string): { added: number; updated: number; errors: string[] } {
    const out = { added: 0, updated: 0, errors: [] as string[] };
    const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const sep = line.includes(";") ? ";" : line.includes("\t") ? "\t" : ",";
      const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
      if (i === 0 && !/\d/.test(cols[0] ?? "")) return; // en-tête
      try {
        const [code, name, price] = cols;
        const priceCents = Math.round(Number(String(price ?? "").replace(/[€\s]/g, "").replace(",", ".")) * 100);
        const exists = this.items.has(cleanCode(code));
        const p = this.validate({ code, name, priceCents });
        this.items.set(p.code, p);
        if (exists) out.updated++;
        else out.added++;
      } catch (e) {
        if (out.errors.length < 20) out.errors.push(`Ligne ${i + 1} : ${(e as Error).message}`);
      }
    });
    this.persist();
    return out;
  }

  exportCsv(): string {
    const rows = this.list().map((p) => `${p.code};${p.name.replace(/;/g, ",")};${(p.priceCents / 100).toFixed(2).replace(".", ",")}`);
    return "﻿code;nom;prix\r\n" + rows.join("\r\n") + "\r\n";
  }

  private validate(p: Product): Product {
    const code = cleanCode(p?.code);
    if (!CODE_RE.test(code)) throw new Error("code-barres invalide");
    const name = String(p?.name ?? "").trim().slice(0, 120);
    if (!name) throw new Error("nom manquant");
    const priceCents = Math.round(Number(p?.priceCents));
    if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000) throw new Error("prix invalide");
    return { code, name, priceCents };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.list()), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
