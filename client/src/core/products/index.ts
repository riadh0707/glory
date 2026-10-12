/**
 * Catalogue d'articles : code-barres → nom + prix. Stocké dans
 * userData/products.json (quelques milliers d'articles restent instantanés).
 */
import * as fs from "fs";
import * as path from "path";

export interface Product {
  /**
   * Code-barres tel que lu par le scanner (EAN-13, EAN-8, UPC, Code 128…).
   * Article sans code-barres : code interne « ART-xxxxxx » généré.
   */
  code: string;
  name: string;
  priceCents: number;
  /** Rayon / catégorie (pour la liste des articles à la caisse). */
  category?: string;
  /** Photo réduite (data:image/jpeg). */
  image?: string;
  /** Stock suivi (null/absent = pas de suivi). Diminue à chaque vente. */
  stock?: number | null;
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
    const clean = this.validate({ ...p, code: cleanCode(p?.code) || this.newInternalCode() });
    if (previousCode && previousCode !== clean.code) this.items.delete(cleanCode(previousCode));
    this.items.set(clean.code, clean);
    this.persist();
    return clean;
  }

  /** Retire du stock les articles vendus (articles suivis seulement). */
  consume(items: SaleItem[]): void {
    let changed = false;
    for (const it of items) {
      const p = it.code ? this.items.get(it.code) : undefined;
      if (p && typeof p.stock === "number") {
        p.stock -= it.qty;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  categories(): string[] {
    return [...new Set(this.list().map((p) => p.category ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  }

  private newInternalCode(): string {
    let c = "";
    do c = `ART-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    while (this.items.has(c));
    return c;
  }

  remove(code: string): void {
    this.items.delete(cleanCode(code));
    this.persist();
  }

  /**
   * Import d'un fichier CSV « code;nom;prix » (séparateur ; ou , ou tabulation,
   * prix en euros « 2,50 » ou « 2.50 », ligne d'en-tête facultative).
   */
  /**
   * Import d'un catalogue complet (.json, avec photos) :
   * { "products": [ { "name", "priceCents", "category"?, "code"?, "stock"?, "image"? } ] }.
   * Un article sans code est ajouté (ou remplacé s'il existe déjà un article
   * sans code-barres du même nom).
   */
  importJson(text: string): { added: number; updated: number; errors: string[] } {
    const out = { added: 0, updated: 0, errors: [] as string[] };
    let list: unknown[];
    try {
      const j = JSON.parse(String(text ?? "").replace(/^\uFEFF/, ""));
      list = Array.isArray(j) ? j : Array.isArray(j?.products) ? j.products : [];
    } catch {
      return { ...out, errors: ["fichier illisible (JSON attendu)"] };
    }
    list.slice(0, 20000).forEach((raw, i) => {
      try {
        const p = raw as Product;
        let code = cleanCode(p?.code);
        if (!code) code = [...this.items.values()].find((x) => x.code.startsWith("ART-") && x.name === String(p?.name ?? "").trim())?.code ?? this.newInternalCode();
        const exists = this.items.has(code);
        const clean = this.validate({ ...p, code });
        this.items.set(clean.code, clean);
        if (exists) out.updated++;
        else out.added++;
      } catch (e) {
        if (out.errors.length < 20) out.errors.push(`Article ${i + 1} : ${(e as Error).message}`);
      }
    });
    this.persist();
    return out;
  }

  importCsv(text: string): { added: number; updated: number; errors: string[] } {
    const out = { added: 0, updated: 0, errors: [] as string[] };
    const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const sep = line.includes(";") ? ";" : line.includes("\t") ? "\t" : ",";
      const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
      if (i === 0 && !/\d/.test(cols[0] ?? "")) return; // en-tête
      try {
        const [code, name, price, category, stock] = cols;
        const priceCents = Math.round(Number(String(price ?? "").replace(/[€\s]/g, "").replace(",", ".")) * 100);
        const exists = this.items.has(cleanCode(code));
        const prev = this.items.get(cleanCode(code));
        const p = this.validate({ code: cleanCode(code) || this.newInternalCode(), name, priceCents, category: category ?? prev?.category, image: prev?.image, stock: stock !== undefined && stock !== "" ? Number(stock) : prev?.stock });
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
    const rows = this.list().map(
      (p) => `${p.code};${p.name.replace(/;/g, ",")};${(p.priceCents / 100).toFixed(2).replace(".", ",")};${(p.category ?? "").replace(/;/g, ",")};${typeof p.stock === "number" ? p.stock : ""}`
    );
    return "﻿code;nom;prix;categorie;stock\r\n" + rows.join("\r\n") + "\r\n";
  }

  private validate(p: Product): Product {
    const code = cleanCode(p?.code);
    if (!CODE_RE.test(code)) throw new Error("code-barres invalide");
    const name = String(p?.name ?? "").trim().slice(0, 120);
    if (!name) throw new Error("nom manquant");
    const priceCents = Math.round(Number(p?.priceCents));
    if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000) throw new Error("prix invalide");
    const out: Product = { code, name, priceCents };
    const category = String(p?.category ?? "").trim().slice(0, 60);
    if (category) out.category = category;
    if (typeof p?.image === "string" && p.image) {
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) || p.image.length > 400_000) throw new Error("image invalide ou trop grande");
      out.image = p.image;
    }
    if (p?.stock !== null && p?.stock !== undefined && String(p.stock) !== "") {
      const stock = Math.round(Number(p.stock));
      if (!Number.isInteger(stock) || Math.abs(stock) > 1_000_000) throw new Error("stock invalide");
      out.stock = stock;
    }
    return out;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.list()), "utf8");
    fs.renameSync(tmp, this.file);
  }
}
