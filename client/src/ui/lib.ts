/**
 * Outils communs de l'interface. Fichier script (pas de module) : ses
 * déclarations sont globales et utilisées par app.ts et screens.ts.
 */

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll(sel)) as T[];

/** Échappe toute donnée dynamique avant insertion dans du HTML. */
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const moneyFmt = new Intl.NumberFormat("fr-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1234 → "12,34 €". */
function money(cents: number | null | undefined, cc = "EUR"): string {
  const v = moneyFmt.format((cents ?? 0) / 100);
  return cc === "EUR" ? `${v} €` : `${v} ${cc}`;
}

/** Valeur faciale lisible : fv=2000 → "20 €", fv=50 → "50 c". */
function faceLabel(fv: string | number): string {
  const n = Number(fv);
  if (n >= 100) return `${n / 100} €`;
  return `${n} c`;
}

function sumCents(lines: DenomLine[]): number {
  return lines.reduce((s, l) => s + l.piece * Number(l.fv), 0);
}

function aggregateLines(lines: DenomLine[]): DenomLine[] {
  const map = new Map<string, DenomLine>();
  for (const l of lines) {
    const key = `${l.cc}|${l.fv}`;
    const cur = map.get(key) ?? { ...l, piece: 0 };
    cur.piece += l.piece;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => Number(b.fv) - Number(a.fv));
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("fr-BE")} ${d.toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" })}`;
}

// ------------------------------------------------------------------ notifications

function toast(message: string, kind: "ok" | "error" | "info" = "info"): void {
  const host = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add("leave"), kind === "error" ? 6000 : 3500);
  setTimeout(() => el.remove(), kind === "error" ? 6400 : 3900);
}

function report(r: OpResult, okMessage?: string): boolean {
  toast(r.ok ? (okMessage ?? r.message) : r.message, r.ok ? "ok" : "error");
  return r.ok;
}

/** Boîte de dialogue modale générique. Renvoie la valeur passée à `close`. */
function modal<T>(build: (body: HTMLElement, close: (v: T | null) => void) => void, opts: { title: string; wide?: boolean }): Promise<T | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `<div class="dialog ${opts.wide ? "dialog-wide" : ""}" role="dialog" aria-modal="true">
      <div class="dialog-head"><h2>${esc(opts.title)}</h2><button class="icon-btn" data-x aria-label="Fermer">✕</button></div>
      <div class="dialog-body"></div></div>`;
    document.body.appendChild(overlay);
    const close = (v: T | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);
    $("[data-x]", overlay).addEventListener("click", () => close(null));
    build($(".dialog-body", overlay), close);
  });
}

function confirmDialog(title: string, text: string, okLabel = "Confirmer", danger = false): Promise<boolean> {
  return modal<boolean>(
    (body, close) => {
      body.innerHTML = `<p class="dialog-text">${esc(text)}</p>
        <div class="dialog-actions"><button class="btn" data-no>Annuler</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(okLabel)}</button></div>`;
      $("[data-no]", body).addEventListener("click", () => close(false));
      $("[data-yes]", body).addEventListener("click", () => close(true));
      $<HTMLButtonElement>("[data-yes]", body).focus();
    },
    { title }
  ).then((v) => v === true);
}

/** Désactive un bouton pendant l'action et remonte toute exception au journal. */
async function busy<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(msg, "error");
    void window.api.call("diag.rendererError", "action", msg, err instanceof Error ? err.stack : undefined);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ------------------------------------------------------------------ pavé numérique

/** "12,5" → 1250 centimes. */
function parseAmount(text: string): number {
  if (!text) return 0;
  const [eur, dec = ""] = text.split(",");
  return Number(eur || "0") * 100 + Number((dec + "00").slice(0, 2));
}

/**
 * Affichage pendant la saisie (HTML) : ce qui est tapé en clair, les
 * décimales pas encore tapées en grisé — « 12 » → 12<gris>,00</gris> €,
 * « 12,5 » → 12,5<gris>0</gris> €. On voit toujours le montant final.
 */
function amountDisplay(text: string): string {
  if (!text) return `0<span class="dim">,00</span> €`;
  const [eur, dec] = text.split(",");
  const eurFmt = Number(eur || "0").toLocaleString("fr-BE");
  if (dec === undefined) return `${eurFmt}<span class="dim">,00</span> €`;
  return `${eurFmt},${dec}<span class="dim">${"00".slice(dec.length)}</span> €`;
}

/** « lundi 5 octobre » → « Lundi 5 octobre ». */
function longDate(d = new Date()): string {
  const s = d.toLocaleDateString("fr-BE", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Pavé numérique tactile.
 * - `money` : saisie naturelle en euros avec virgule (1, 2, ",", 5 →
 *   12,50 €), 2 décimales max. Les touches « , » et « . » du clavier
 *   physique marchent aussi.
 * - `pin` : chiffres seuls (affichés masqués par l'appelant).
 */
function keypad(host: HTMLElement, opts: { mode: "money" | "pin"; onChange?: (text: string, cents: number) => void; onEnter?: () => void }): { value(): string; cents(): number; set(v: string): void } {
  let text = "";
  host.classList.add("keypad");
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", opts.mode === "money" ? "," : "C", "0", "⌫"];
  host.innerHTML = keys
    .map((k) => `<button type="button" class="key ${k === "⌫" || k === "C" ? "key-muted" : ""} ${k === "," ? "key-comma" : ""}" data-k="${k}" aria-label="${k === "⌫" ? "Effacer" : k === "," ? "Virgule" : k}">${k === "⌫" ? '<svg viewBox="0 0 24 24"><path d="M9 6h11v12H9l-6-6z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg>' : k}</button>`)
    .join("");
  const update = () => opts.onChange?.(text, opts.mode === "money" ? parseAmount(text) : 0);
  const press = (k: string) => {
    if (k === "⌫") text = text.slice(0, -1);
    else if (k === "C") text = "";
    else if (k === ",") {
      if (opts.mode !== "money" || text.includes(",")) return;
      text = (text || "0") + ",";
    } else if (opts.mode === "money") {
      const [eur, dec] = text.split(",");
      if (dec !== undefined) {
        if (dec.length >= 2) return;
      } else if (eur.replace(/^0+/, "").length >= 6) return;
      text = (text + k).replace(/^0+(?=\d)/, "");
    } else if (text.length < 8) text += k;
    update();
  };
  host.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-k]") as HTMLButtonElement | null;
    if (b) press(b.dataset.k!);
  });
  const onKey = (e: KeyboardEvent) => {
    if (!host.isConnected) return document.removeEventListener("keydown", onKey);
    if ((e.target as HTMLElement).closest("input, textarea, select") || document.querySelector(".overlay")) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === "," || e.key === "." || e.key === "Decimal") press(",");
    else if (e.key === "Backspace") press("⌫");
    else if (e.key === "Enter") opts.onEnter?.();
    else if (e.key === "Delete" || e.key === "Escape") {
      text = "";
      update();
    } else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  return {
    value: () => text,
    cents: () => (opts.mode === "money" ? parseAmount(text) : 0),
    set: (v: string) => {
      text = v;
      update();
    },
  };
}

// ------------------------------------------------------------------ visuels espèces

const NOTE_COLORS: Record<number, string> = {
  500: "#8a9a8b",
  1000: "#c4504a",
  2000: "#3f6db3",
  5000: "#e0892e",
  10000: "#3c9a5c",
  20000: "#c7a03a",
  50000: "#8d5aa0",
};

/** Petit billet stylisé (pas une reproduction : couleur + valeur). */
function noteHtml(fv: string | number, size: "sm" | "md" = "md"): string {
  const n = Number(fv);
  const color = NOTE_COLORS[n] ?? "#6b7280";
  return `<span class="note note-${size}" style="--note:${color}"><span class="note-val">${n / 100}</span><span class="note-cur">EURO</span></span>`;
}

function coinHtml(fv: string | number, size: "sm" | "md" = "md"): string {
  const n = Number(fv);
  const kind = n <= 5 ? "copper" : n < 100 ? "gold" : n === 100 ? "bi1" : "bi2";
  const label = n >= 100 ? `${n / 100}€` : `${n}`;
  return `<span class="coin coin-${size} coin-${kind}"><span>${label}</span></span>`;
}

function cashHtml(l: DenomLine, size: "sm" | "md" = "md"): string {
  return l.devid === "2" || Number(l.fv) < 500 ? coinHtml(l.fv, size) : noteHtml(l.fv, size);
}

/** Liste compacte "2 × 20 €, 1 × 5 €". */
function linesSummary(lines: DenomLine[]): string {
  return aggregateLines(lines)
    .filter((l) => l.piece > 0)
    .map((l) => `${l.piece} × ${faceLabel(l.fv)}`)
    .join(", ");
}

// ------------------------------------------------------------------ ticket & impression

const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function ean13(digits12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  return digits12 + String((10 - (sum % 10)) % 10);
}

function ean13Svg(code: string): string {
  const first = Number(code[0]);
  let bits = "101";
  for (let i = 1; i <= 6; i++) bits += EAN_PARITY[first][i - 1] === "L" ? EAN_L[Number(code[i])] : EAN_G[Number(code[i])];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += EAN_R[Number(code[i])];
  bits += "101";
  const bars = [...bits].map((b, i) => (b === "1" ? `<rect x="${i}" y="0" width="1" height="50"/>` : "")).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bits.length} 50" width="220" height="60" preserveAspectRatio="none" fill="#000">${bars}</svg>`;
}

interface TicketLine {
  label: string;
  value: string;
  strong?: boolean;
}

/** Ticket générique (vente, collecte, clôture...) au format rouleau. */
function ticketHtml(s: ReceiptSettings, title: string, ticketNo: number | null, lines: TicketLine[], opts: { barcodeCents?: number; user?: string } = {}): string {
  const now = new Date();
  const code = ticketNo !== null && opts.barcodeCents !== undefined
    ? ean13("25" + String(ticketNo % 100000).padStart(5, "0") + String(Math.min(opts.barcodeCents, 99999)).padStart(5, "0"))
    : null;
  return `<div class="receipt">
    <div class="r-title">${esc(s.companyName)}</div>
    ${s.companyLine2 ? `<div class="r-sub">${esc(s.companyLine2)}</div>` : ""}
    <div class="r-row"><span>${now.toLocaleDateString("fr-BE")}</span><span>${now.toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" })}</span>${ticketNo !== null ? `<span>N° ${String(ticketNo).padStart(6, "0")}</span>` : ""}</div>
    ${opts.user || s.operatorName ? `<div>${esc(opts.user || s.operatorName)}</div>` : ""}
    <div class="r-head">${esc(title)}</div>
    ${lines.map((l) => `<div class="r-row ${l.strong ? "r-strong" : ""}"><span>${esc(l.label)}</span><span>${esc(l.value)}</span></div>`).join("")}
    ${code ? `<div class="r-barcode">${ean13Svg(code)}<div>${code[0]} ${code.slice(1, 7)} ${code.slice(7)}</div></div>` : ""}
    ${s.footerMessage ? `<div class="r-foot">${esc(s.footerMessage)}</div>` : ""}
  </div>`;
}

/** Imprime via le dialogue système, page adaptée au papier choisi. */
function printTicket(html: string, paper: ReceiptSettings["paperFormat"]): void {
  const width = paper === "58mm" ? "54mm" : paper === "80mm" ? "76mm" : "120mm";
  const page = paper === "A4" ? "A4" : `${paper} auto`;
  let style = document.getElementById("paper-style") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "paper-style";
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: ${page}; margin: 3mm; } .receipt { width: ${width}; }`;
  $("#print-area").innerHTML = html;
  window.print();
}

/** Lignes de ticket pour une liste de dénominations. */
function denomTicketLines(lines: DenomLine[]): TicketLine[] {
  return aggregateLines(lines)
    .filter((l) => l.piece > 0)
    .map((l) => ({ label: `${l.piece} × ${faceLabel(l.fv)}`, value: money(l.piece * Number(l.fv), l.cc) }));
}
