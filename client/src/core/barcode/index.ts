/**
 * Lecture des codes-barres scannés.
 *
 * - Contrôle de la clé des EAN-13 / EAN-8 / UPC-A (une mauvaise lecture est
 *   rejetée au lieu d'ajouter un mauvais article).
 * - Codes à prix intégré (étiquettes de balance, GS1 « 2x ») : EAN-13 dont
 *   le préfixe est configuré ; chiffres 1-7 = référence, 8-12 = prix en
 *   centimes, 13 = clé. Ex. 2212345 01234 C → réf. 2212345, 12,34 €.
 */
export type ScanResult =
  | { kind: "product"; code: string }
  | { kind: "embedded-price"; code: string; ref: string; priceCents: number }
  | { kind: "invalid"; code: string; reason: string };

function gtinCheckOk(digits: string): boolean {
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    const n = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

export function parsePrefixes(s: string): string[] {
  return String(s ?? "")
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter((p) => /^\d{1,3}$/.test(p));
}

export function analyzeScan(raw: string, opts: { embeddedPrice: boolean; prefixes: string[] }): ScanResult {
  const code = String(raw ?? "").trim();
  if (/^\d+$/.test(code) && [8, 12, 13].includes(code.length) && !gtinCheckOk(code)) {
    return { kind: "invalid", code, reason: "Code-barres mal lu (clé de contrôle incorrecte). Scannez à nouveau." };
  }
  if (/^\d{13}$/.test(code)) {
    if (opts.embeddedPrice && opts.prefixes.some((p) => code.startsWith(p))) {
      return { kind: "embedded-price", code, ref: code.slice(0, 7), priceCents: Number(code.slice(7, 12)) };
    }
  }
  return { kind: "product", code };
}
