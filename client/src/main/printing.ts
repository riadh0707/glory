/**
 * Impression des tickets et rapports.
 *
 * Deux voies :
 * - « système » : le document est chargé dans une fenêtre cachée dédiée puis
 *   envoyé au dialogue d'impression de Windows / Linux ;
 * - « navigateur » : le document est écrit dans un fichier HTML et ouvert
 *   dans le navigateur par défaut, qui lance son propre dialogue d'impression.
 * Le choix se fait dans les réglages.
 */
import { BrowserWindow, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

export type PrintMethod = "system" | "browser";
export type PaperFormat = "58mm" | "80mm" | "A4";

export interface PrintResult {
  ok: boolean;
  message: string;
  /** Voie réellement utilisée. */
  via?: "system" | "browser";
  cancelled?: boolean;
}

function receiptCss(): string {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "ui", "receipt.css"), "utf8");
  } catch {
    return "";
  }
}

function pageCss(paper: PaperFormat): string {
  const width = paper === "58mm" ? "54mm" : paper === "80mm" ? "76mm" : "120mm";
  // Rouleaux : pas de « size » (« 80mm auto » est invalide et donne une page
  // paysage) — c'est le pilote de l'imprimante ticket qui fixe la longueur.
  const size = paper === "A4" ? "size: A4 portrait; " : "";
  return `@page { ${size}margin: ${paper === "A4" ? "12mm" : "2mm"}; } .receipt { width: ${width}; margin: 0 auto; }`;
}

/** Document HTML autonome (aucune dépendance à l'application). */
function buildDocument(body: string, paper: PaperFormat, forBrowser: boolean): string {
  const browserExtras = forBrowser
    ? `<style>@media screen { body { background: #e9ecea; padding: 24px 0; } .receipt { background: #fff; padding: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.15); } .no-print { text-align: center; margin: 0 0 18px; font-family: system-ui, sans-serif; } .no-print button { font: inherit; font-size: 16px; padding: 10px 22px; border-radius: 8px; border: 0; background: #0b7a5e; color: #fff; cursor: pointer; } }
       @media print { .no-print { display: none; } }</style>
       <script>addEventListener("load", function () { setTimeout(function () { window.print(); }, 400); });</script>`
    : "";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Ticket</title>
<style>body { margin: 0; background: #fff; color: #000; } ${receiptCss()} ${pageCss(paper)}</style>${browserExtras}</head>
<body>${forBrowser ? `<div class="no-print"><button onclick="window.print()">Imprimer</button></div>` : ""}${body}</body></html>`;
}

/** Le contenu vient de l'interface (texte déjà échappé) ; on refuse tout script par précaution. */
function isSafeBody(body: string): boolean {
  return !/<\s*(script|iframe|object|embed)\b|\son[a-z]+\s*=|javascript:/i.test(body);
}

function printSystem(doc: string): Promise<PrintResult> {
  return new Promise((resolve) => {
    let win: BrowserWindow | null = null;
    const done = (r: PrintResult) => {
      if (win && !win.isDestroyed()) win.destroy();
      resolve(r);
    };
    try {
      win = new BrowserWindow({ show: false, width: 420, height: 800, webPreferences: { javascript: false, sandbox: true } });
      win.webContents
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(doc)}`)
        .then(() => {
          win!.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
            if (success) return done({ ok: true, message: "Envoyé à l'imprimante.", via: "system" });
            const cancelled = /cancel/i.test(reason ?? "");
            done({ ok: false, cancelled, message: cancelled ? "Impression annulée." : `Impression système impossible (${reason || "erreur inconnue"}).`, via: "system" });
          });
        })
        .catch((e: Error) => done({ ok: false, message: `Impression système impossible (${e.message}).`, via: "system" }));
    } catch (e) {
      done({ ok: false, message: `Impression système impossible (${(e as Error).message}).`, via: "system" });
    }
  });
}

async function printBrowser(doc: string, dataDir: string): Promise<PrintResult> {
  const dir = path.join(dataDir, "impression");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Ménage : on ne garde que les fichiers des dernières 24 h.
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) fs.rmSync(p, { force: true });
    }
  } catch {
    /* le ménage n'est pas essentiel */
  }
  const file = path.join(dir, `ticket-${Date.now()}.html`);
  try {
    fs.writeFileSync(file, doc, "utf8");
  } catch (e) {
    return { ok: false, message: `Impossible d'écrire le ticket (${(e as Error).message}).`, via: "browser" };
  }
  // openExternal ouvre le navigateur par défaut ; openPath sert de secours
  // (programme associé aux fichiers .html).
  try {
    await shell.openExternal(pathToFileURL(file).href);
    return { ok: true, message: "Ticket ouvert dans le navigateur pour l'impression.", via: "browser" };
  } catch {
    const err = await shell.openPath(file);
    if (!err) return { ok: true, message: "Ticket ouvert dans le navigateur pour l'impression.", via: "browser" };
    shell.showItemInFolder(file);
    return { ok: false, message: `Aucun navigateur n'a pu s'ouvrir. Le ticket est enregistré ici : ${file}`, via: "browser" };
  }
}

export async function printDocument(body: string, paper: PaperFormat, method: PrintMethod, dataDir: string): Promise<PrintResult> {
  if (typeof body !== "string" || body.length > 2_000_000 || !isSafeBody(body)) return { ok: false, message: "Document à imprimer invalide." };
  const p: PaperFormat = paper === "58mm" || paper === "A4" ? paper : "80mm";
  return method === "system" ? printSystem(buildDocument(body, p, false)) : printBrowser(buildDocument(body, p, true), dataDir);
}
