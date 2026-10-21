import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, shell } from "electron";
import * as fs from "fs";
import * as zlib from "zlib";
import * as path from "path";
import { IpcChannels } from "../shared/ipc-channels";
import { HistoryStore } from "../core/history-store";
import { Ledger } from "../core/ledger";
import { getModelConfig, isConfirmedModel } from "../core/model-adapter";
import { generateDiagnosticReport } from "../core/diagnostic-report";
import { loadFccConfig, saveFccConfig, FccConnectionConfig } from "../core/fcc-config";
import { loadReceiptSettings, saveReceiptSettings, takeNextTicketNumber, ReceiptSettings } from "../core/receipt-settings";
import { loadAppSettings, saveAppSettings, AppSettings } from "../core/app-settings";
import { listUsers, saveUser, deleteUser, verifyUser, PublicUser, Role } from "../core/users";
import { computeStats, localDayRange, transactionsCsv } from "../core/stats";
import { aggregate, DenomLine, totalCents } from "../core/cash";
import { Cashier } from "./cashier";
import { printDocument, PaperFormat } from "./printing";
import { Updater } from "./updater";
import { LicenseManager, LicenseStatus } from "../core/license";
import { describeDeviceError, isHelpPath } from "../core/device-errors";
import { ProductStore, Product, cleanItems, itemsTotal } from "../core/products";
import { analyzeScan, parsePrefixes } from "../core/barcode";
import axios from "axios";
import * as https from "https";

const ACTIVE_MODEL_ID = "CI-10";

// Avant app.getPath("userData") pour que le dossier de données porte ce nom.
app.setName("MedaCash");
// Le logiciel s'appelait « Glory FCC Client » : on garde son dossier de données
// pour que la mise à jour conserve ventes, réglages, articles et licence.
// (sauf dossier imposé au lancement par --user-data-dir).
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", path.join(app.getPath("appData"), "Glory FCC Client"));

// Version installée : pas d'outils de développement ni de débogage à distance
// (sinon on pourrait inspecter ou piloter le logiciel de l'extérieur).
if (app.isPackaged) {
  const banned = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "js-flags"];
  if (banned.some((sw) => app.commandLine.hasSwitch(sw)) || process.argv.some((a) => /^--(inspect|remote-debugging)/.test(a))) {
    app.exit(1);
  }
}

/**
 * Toujours `userData` : `dist/` est dans `app.asar`, en lecture seule une
 * fois l'app installée (crash au démarrage constaté le 2026-07-29).
 */
const DATA_DIR = app.getPath("userData");
const APP_STARTED_AT = new Date().toISOString();

let mainWindow: BrowserWindow | null = null;
const history = new HistoryStore(path.join(DATA_DIR, "glory-client.db"));
const ledger = new Ledger(path.join(DATA_DIR, "caisse.db"));
let currentUser: PublicUser | null = null;
const products = new ProductStore(DATA_DIR);
const updater = new Updater((s) => send(IpcChannels.Update, s), (line) => log(line));
const license = new LicenseManager(DATA_DIR, app.getVersion(), (url, init) => net.fetch(url, init));

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function log(line: string): void {
  send(IpcChannels.Log, line);
  if (line.startsWith("[ERREUR]")) history.record("error", null, { message: line });
}

const cashier = new Cashier(
  {
    log,
    event: (e) => {
      if (e.kind === "error") {
        e.info = describeDeviceError(e.devid, e.code);
        history.record("error", "device", { devid: e.devid, code: e.info.code, title: e.info.title, detail: e.info.detail });
      }
      send(IpcChannels.FccEvent, e);
    },
    state: (s) => send(IpcChannels.State, s),
  },
  history,
  ledger
);

process.on("uncaughtException", (err) => {
  log(`[ERREUR] Exception non gérée : ${err.message}`);
  history.record("error", "uncaughtException", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log(`[ERREUR] Promesse rejetée non gérée : ${message}`);
  history.record("error", "unhandledRejection", { message, stack: reason instanceof Error ? reason.stack : undefined });
});

function modelDefaults(): FccConnectionConfig {
  const m = getModelConfig(ACTIVE_MODEL_ID);
  return {
    soapEndpoint: isConfirmedModel(m) ? (m.soapEndpoint ?? "") : "",
    rejectUnauthorized: isConfirmedModel(m) ? m.tls.rejectUnauthorized : false,
    eventTcpPort: isConfirmedModel(m) ? m.eventListener.tcpPort : 55561,
    callbackIp: "",
    userId: "posadmin",
    userPwd: "",
  };
}

function fccConfig(): FccConnectionConfig {
  return loadFccConfig(DATA_DIR, modelDefaults());
}

/** Relevé d'ouverture automatique : le premier du jour sert de base à la clôture. */
async function ensureOpeningSnapshot(): Promise<void> {
  const { fromIso, toIso } = localDayRange(todayYmd());
  const last = ledger.lastSnapshot("open", toIso);
  if (last && last.ts >= fromIso) return;
  const inv = await cashier.inventory();
  if (inv.ok && "inventory" in inv && inv.inventory) {
    const lines = aggregate(inv.inventory.device);
    ledger.addSnapshot("open", currentUser?.name ?? "", lines, totalCents(lines));
    log("Relevé d'ouverture de caisse enregistré.");
  }
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rangeOf(fromYmd: string, toYmd: string): { fromIso: string; toIso: string } {
  return { fromIso: localDayRange(fromYmd).fromIso, toIso: localDayRange(toYmd).toIso };
}

// --------------------------------------------------------------------------
// Actions exposées au renderer. `role` : qui peut l'appeler — vérifié ICI,
// pas seulement en masquant des boutons dans l'interface.
// --------------------------------------------------------------------------

type Access = "public" | "user" | "admin";
type Handler = (...args: never[]) => unknown;
const actions: Record<string, { access: Access; fn: Handler }> = {};

function action<A extends unknown[]>(name: string, access: Access, fn: (...args: A) => unknown): void {
  actions[name] = { access, fn: fn as unknown as Handler };
}

// --- licence (seules actions possibles sans licence valide)
action("license.status", "public", () => license.status());
action("license.activate", "public", async (key: string) => {
  const s = await license.activate(String(key ?? ""));
  history.record("app-lifecycle", "license-activate", { ok: s.state === "valid", message: s.message });
  return s;
});
action("license.refresh", "public", () => licenseCheck());
action("license.remove", "admin", async () => {
  license.clear();
  await lockForLicense();
  return license.status();
});

/** Licence perdue en cours de route : on libère le terminal et on prévient l'interface. */
async function lockForLicense(status?: LicenseStatus): Promise<void> {
  currentUser = null;
  cashier.user = "";
  if (cashier.isConnected()) await cashier.disconnect().catch(() => undefined);
  // Garde le motif du refus (le statut recalculé dirait seulement « aucune licence »).
  send(IpcChannels.License, status ?? license.status());
}

async function licenseCheck(): Promise<LicenseStatus> {
  const before = license.isLicensed();
  const s = await license.refresh();
  if (before && s.state !== "valid") {
    log(`[ERREUR] Licence : ${s.message}`);
    history.record("app-lifecycle", "license-lost", { message: s.message });
    await lockForLicense(s);
  }
  return s;
}
setInterval(() => void licenseCheck(), 6 * 3600_000);

// --- comptes
action("users.list", "public", () => listUsers(DATA_DIR));
action("users.setupFirstAdmin", "public", (name: string, pin: string) => {
  if (listUsers(DATA_DIR).length > 0) throw new Error("Un administrateur existe déjà.");
  saveUser(DATA_DIR, name, "admin", pin);
  return { ok: true };
});
// Anti-essais : 5 PIN faux d'affilée → 30 s de blocage (un PIN à 4 chiffres
// se devine sinon en quelques minutes).
let failedLogins = 0;
let loginBlockedUntil = 0;
action("users.login", "public", async (name: string, pin: string) => {
  if (Date.now() < loginBlockedUntil) {
    return { ok: false, message: `Trop d'essais. Réessayez dans ${Math.ceil((loginBlockedUntil - Date.now()) / 1000)} s.` };
  }
  // Une tentative de connexion ferme toujours la session précédente.
  currentUser = null;
  cashier.user = "";
  const u = verifyUser(DATA_DIR, String(name), String(pin));
  history.record("app-lifecycle", "login", { user: name, ok: !!u });
  if (!u) {
    failedLogins += 1;
    if (failedLogins >= 5) {
      failedLogins = 0;
      loginBlockedUntil = Date.now() + 30_000;
      return { ok: false, message: "Trop d'essais. Réessayez dans 30 s." };
    }
    return { ok: false, message: "Code PIN incorrect." };
  }
  failedLogins = 0;
  currentUser = u;
  cashier.user = u.name;
  return { ok: true, user: u };
});
action("users.logout", "user", () => {
  history.record("app-lifecycle", "logout", { user: currentUser?.name });
  currentUser = null;
  cashier.user = "";
  return { ok: true };
});
action("users.me", "public", () => currentUser);
action("users.save", "admin", (name: string, role: Role, pin: string) => {
  saveUser(DATA_DIR, name, role === "admin" ? "admin" : "vendeur", pin);
  return { ok: true };
});
action("users.delete", "admin", (name: string) => {
  if (currentUser && name === currentUser.name) throw new Error("Vous ne pouvez pas supprimer votre propre compte.");
  deleteUser(DATA_DIR, name);
  return { ok: true };
});

// --- réglages
action("settings.fccGet", "admin", () => fccConfig());
action("settings.fccSave", "admin", (c: FccConnectionConfig) => {
  saveFccConfig(DATA_DIR, c);
  history.record("app-lifecycle", "fcc-config-save", { ...c, userPwd: c.userPwd ? "***" : "" });
  return fccConfig();
});
action("settings.receiptGet", "user", () => loadReceiptSettings(DATA_DIR));
action("settings.receiptSave", "admin", (s: ReceiptSettings) => {
  saveReceiptSettings(DATA_DIR, s);
  return loadReceiptSettings(DATA_DIR);
});
action("settings.appGet", "user", () => loadAppSettings(DATA_DIR));
action("settings.appSave", "admin", (s: AppSettings) => saveAppSettings(DATA_DIR, s));
action("print.document", "user", (html: string, paper: PaperFormat) => printDocument(html, paper, loadAppSettings(DATA_DIR).printMethod, DATA_DIR));
action("ticket.next", "user", () => takeNextTicketNumber(DATA_DIR));
action("ticket.attach", "user", (transactionId: number, ticketNo: number) => {
  ledger.setTicket(Number(transactionId), Number(ticketNo));
  return { ok: true };
});

// --- terminal
action("fcc.connect", "user", async () => {
  const cfg = fccConfig();
  if (!cfg.soapEndpoint) return { ok: false, message: "Adresse du terminal non configurée (Réglages)." };
  if (!cfg.callbackIp) return { ok: false, message: "Adresse IP de cet ordinateur non configurée (Réglages)." };
  const m = getModelConfig(ACTIVE_MODEL_ID);
  const r = await cashier.connect(cfg, isConfirmedModel(m) ? m.eventListener.mode : "tcp");
  if (r.ok) {
    // État réel du terminal dès la connexion (erreur, prêt...) pour le voyant.
    await cashier.status();
    await ensureOpeningSnapshot();
    // Comme CI-Activate (time = True) : remet le terminal à l'heure du PC.
    void cashier.syncTime();
  }
  return r;
});
action("fcc.disconnect", "user", () => cashier.disconnect());
action("fcc.status", "user", () => cashier.status());
action("fcc.state", "public", () => cashier.state());
action("fcc.inventory", "user", () => cashier.inventory());

// --- caisse
action("sale.start", "user", async (amountCents: number, rawItems?: unknown) => {
  const items = cleanItems(rawItems);
  const due = items.length ? itemsTotal(items) : Math.round(Number(amountCents));
  if (items.length && due !== Math.round(Number(amountCents))) return { ok: false, message: "Le total du panier a changé : vérifiez le panier." };
  const r = await cashier.sale(due, items);
  if (r.ok) products.consume(items);
  return r;
});

/**
 * Vente payée par carte bancaire / sans contact. Mode manuel : le montant est
 * tapé sur le terminal de paiement et le caissier confirme ici que le
 * paiement est accepté. Aucune espèce ne bouge dans la machine Glory.
 */
action("sale.card", "user", (amountCents: number, rawItems?: unknown, reference?: string) => {
  const items = cleanItems(rawItems);
  const due = items.length ? itemsTotal(items) : Math.round(Number(amountCents));
  if (!Number.isInteger(due) || due <= 0) return { ok: false, message: "Montant invalide." };
  if (items.length && due !== Math.round(Number(amountCents))) return { ok: false, message: "Le total du panier a changé : vérifiez le panier." };
  const ref = String(reference ?? "").trim().slice(0, 40);
  const id = ledger.add({
    kind: "sale",
    user: currentUser?.name ?? "",
    dueCents: due,
    inCents: 0,
    outCents: 0,
    ok: true,
    result: 0,
    items,
    method: "card",
    note: ref ? `Carte, réf. ${ref}` : "Carte",
  });
  products.consume(items);
  return { ok: true, message: "Paiement par carte enregistré.", dueCents: due, inCents: 0, outCents: 0, inLines: [], outLines: [], transactionId: id, method: "card" };
});

// --- articles et scanner
action("products.list", "user", () => products.list());
action("products.categories", "user", () => products.categories());
/** Choix d'une photo d'article : réduite à 320 px et convertie en JPEG. */
action("products.pickImage", "admin", async () => {
  const pick = await dialog.showOpenDialog(mainWindow!, {
    title: "Photo de l'article",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif"] }],
    properties: ["openFile"],
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, message: "Aucune image choisie." };
  let img = nativeImage.createFromPath(pick.filePaths[0]);
  if (img.isEmpty()) return { ok: false, message: "Image illisible (formats acceptés : JPG, PNG, WebP, BMP)." };
  const { width, height } = img.getSize();
  const scale = Math.min(1, 320 / Math.max(width, height));
  if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" });
  return { ok: true, message: "OK", image: `data:image/jpeg;base64,${img.toJPEG(82).toString("base64")}` };
});
action("products.save", "admin", (p: Product, previousCode?: string) => {
  try {
    return { ok: true, message: "Article enregistré.", product: products.save(p, previousCode) };
  } catch (e) {
    return { ok: false, message: `Article refusé : ${(e as Error).message}.` };
  }
});
action("products.remove", "admin", (code: string) => {
  products.remove(String(code ?? ""));
  return { ok: true, message: "Article supprimé." };
});
action("products.import", "admin", async () => {
  const pick = await dialog.showOpenDialog(mainWindow!, {
    title: "Importer des articles",
    filters: [
      { name: "Catalogue ou liste d'articles", extensions: ["json", "csv", "txt"] },
      { name: "Catalogue avec photos (.json)", extensions: ["json"] },
      { name: "CSV (Excel)", extensions: ["csv", "txt"] },
    ],
    properties: ["openFile"],
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, message: "Import annulé." };
  const file = pick.filePaths[0];
  if (fs.statSync(file).size > 60 * 1024 * 1024) return { ok: false, message: "Fichier trop volumineux." };
  const text = fs.readFileSync(file, "utf8");
  const r = /\.json$/i.test(file) ? products.importJson(text) : products.importCsv(text);
  return { ok: true, message: `${r.added} ajouté(s), ${r.updated} mis à jour${r.errors.length ? `, ${r.errors.length} ligne(s) ignorée(s)` : ""}.`, errors: r.errors };
});
action("products.export", "admin", async () => {
  const target = await dialog.showSaveDialog(mainWindow!, {
    title: "Exporter les articles",
    defaultPath: "articles.csv",
    filters: [{ name: "CSV (Excel)", extensions: ["csv"] }],
  });
  if (target.canceled || !target.filePath) return { ok: false, message: "Export annulé." };
  fs.writeFileSync(target.filePath, products.exportCsv(), "utf8");
  return { ok: true, message: `${products.list().length} article(s) exporté(s).` };
});
/** Code scanné → article du catalogue, prix intégré, ticket de caisse ou code mal lu. */
action("scan.lookup", "user", (raw: string) => {
  const exact = products.find(String(raw ?? ""));
  if (exact) return { kind: "product", code: exact.code, product: exact };
  const st = loadAppSettings(DATA_DIR);
  const r = analyzeScan(String(raw ?? ""), { embeddedPrice: st.scanEmbeddedPrice, prefixes: parsePrefixes(st.scanPricePrefixes) });
  if (r.kind === "product") return { ...r, product: null };
  if (r.kind === "embedded-price") return { ...r, product: products.find(r.ref) ?? products.find(r.code) };
  return r;
});
action("sale.cancel", "user", () => cashier.cancelSale());
action("deposit.start", "user", () => cashier.depositStart());
action("deposit.end", "user", () => cashier.depositEnd());
action("deposit.cancel", "user", () => cashier.depositCancel());
action("payout", "admin", (amountCents: number, reason: string) => cashier.payout(Math.round(Number(amountCents)), String(reason ?? "")));
action("exchange.start", "user", () => cashier.exchangeStart());
action("exchange.received", "user", () => cashier.exchangeReceived());
action("exchange.give", "user", (receivedCents: number, receivedLines: DenomLine[], give: DenomLine[]) =>
  cashier.exchangeGive(Number(receivedCents), receivedLines, give)
);
action("coins.return", "user", () => cashier.returnCoins());
action("cover.open", "user", () => cashier.openCover());
action("cover.close", "user", () => cashier.closeCover());
action("device.reset", "user", () => cashier.reset());

// --- gestion (administrateur)
action("refill.start", "admin", () => cashier.refillStart());
action("refill.end", "admin", () => cashier.refillEnd());
action("refill.cancel", "admin", () => cashier.refillCancel());
action("collect.plan", "admin", (mode: string, cents: number, kind: string) =>
  cashier.collectPlan(
    mode === "float" || mode === "exact" ? mode : "all",
    Math.round(Number(cents)) || 0,
    kind === "notes" || kind === "coins" ? kind : "all",
    loadAppSettings(DATA_DIR).floatComposition
  )
);
action("collect.run", "admin", (lines: DenomLine[]) => cashier.collect(lines));
action("unit.unlock", "admin", (unit: 1 | 2) => cashier.unlock(unit === 2 ? 2 : 1));
action("unit.lock", "admin", (unit: 1 | 2) => cashier.lock(unit === 2 ? 2 : 1));
action("device.reboot", "admin", () => cashier.reboot());
action("device.shutdown", "admin", () => cashier.shutdown());
action("device.syncTime", "admin", () => cashier.syncTime());

// --- historique & statistiques
action("history.list", "user", (fromYmd: string, toYmd: string) => {
  const { fromIso, toIso } = rangeOf(fromYmd, toYmd);
  return ledger.list(fromIso, toIso);
});
action("stats.period", "user", (fromYmd: string, toYmd: string) => {
  const { fromIso, toIso } = rangeOf(fromYmd, toYmd);
  return computeStats(ledger.list(fromIso, toIso), fromIso, toIso);
});
action("stats.closing", "admin", async () => {
  const { fromIso, toIso } = localDayRange(todayYmd());
  const stats = computeStats(ledger.list(fromIso, toIso), fromIso, toIso);
  const opening = ledger.lastSnapshot("open", toIso);
  const inv = await cashier.inventory();
  if (!inv.ok || !("inventory" in inv) || !inv.inventory) return { ok: false, message: inv.message };
  const closingLines = aggregate(inv.inventory.device);
  const closingCents = totalCents(closingLines);
  const openingCents = opening && opening.ts >= fromIso ? opening.totalCents : null;
  ledger.addSnapshot("close", currentUser?.name ?? "", closingLines, closingCents);
  return {
    ok: true,
    stats,
    openingCents,
    closingCents,
    closingLines,
    expectedCents: openingCents === null ? null : openingCents + stats.netMovementCents,
  };
});
action("history.exportCsv", "admin", async (fromYmd: string, toYmd: string) => {
  const { fromIso, toIso } = rangeOf(fromYmd, toYmd);
  const rows = ledger.list(fromIso, toIso);
  const target = await dialog.showSaveDialog(mainWindow!, {
    title: "Exporter l'historique",
    defaultPath: `caisse_${fromYmd}_${toYmd}.csv`,
    filters: [{ name: "CSV (Excel)", extensions: ["csv"] }],
  });
  if (target.canceled || !target.filePath) return { ok: false, message: "Export annulé." };
  fs.writeFileSync(target.filePath, transactionsCsv(rows), "utf8");
  return { ok: true, message: `${rows.length} opération(s) exportée(s).` };
});

// --- assistance / outils techniques
action("diag.report", "user", async () => {
  const cfg = fccConfig();
  const events = history.getAllEvents().filter((e) => e.ts >= APP_STARTED_AT);
  const r = generateDiagnosticReport(
    path.join(DATA_DIR, "reports"),
    {
      modelId: ACTIVE_MODEL_ID,
      soapEndpoint: cfg.soapEndpoint,
      appStartedAt: APP_STARTED_AT,
      reportGeneratedAt: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}, v${app.getVersion()}`,
      nodeVersion: process.version,
    },
    events.slice(-2000)
  );
  // Envoi automatique au support (PC activé, si internet) ; sinon le fichier reste sur ce PC.
  const id = license.identity();
  let sent = false;
  if (id) {
    try {
      const gz = zlib.gzipSync(fs.readFileSync(r.markdownPath), { level: 9 });
      const res = await net.fetch(id.serverUrl + "/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: id.key, machineId: id.machineId, version: app.getVersion(), gzip: gz.toString("base64") }),
        signal: AbortSignal.timeout(30_000),
      });
      sent = res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
    } catch {
      sent = false;
    }
  }
  history.record("app-lifecycle", "diag-report", { sent, events: r.eventCount, errors: r.errorCount });
  if (!sent) void shell.showItemInFolder(r.markdownPath);
  return {
    ok: true,
    sent,
    message: sent
      ? `Rapport envoyé au support (${r.eventCount} événements, ${r.errorCount} erreurs).`
      : `Rapport créé sur ce PC (${r.eventCount} événements, ${r.errorCount} erreurs) : pas d'envoi possible (internet ?), envoyez le fichier par e-mail.`,
    path: r.markdownPath,
  };
});
action("diag.rendererError", "public", (context: string, message: string, stack?: string) => {
  log(`[ERREUR] (interface) ${context} : ${message}`);
  history.record("error", `renderer:${context}`, { message, stack });
});
// Animation d'aide (GIF) servie par le terminal, renvoyée en data: URL (la
// page n'a pas le droit de charger d'images externes). Limité aux fichiers
// /help/… de l'adresse du terminal configurée.
const helpImages = new Map<string, string>();
action("device.errorImage", "user", async (pathOrUrl: string) => {
  let p = String(pathOrUrl ?? "");
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    return { ok: false, message: "Lien d'aide invalide." };
  }
  if (!isHelpPath(p)) return { ok: false, message: "Lien d'aide invalide." };
  const cached = helpImages.get(p);
  if (cached) return { ok: true, message: "OK", dataUrl: cached };
  const cfg = fccConfig();
  const origin = new URL(cfg.soapEndpoint).origin;
  const r = await axios.get<ArrayBuffer>(origin + p, {
    responseType: "arraybuffer",
    timeout: 20_000,
    maxContentLength: 8 * 1024 * 1024,
    httpsAgent: new https.Agent({ rejectUnauthorized: cfg.rejectUnauthorized }),
  });
  const dataUrl = `data:image/gif;base64,${Buffer.from(r.data).toString("base64")}`;
  if (helpImages.size > 30) helpImages.clear();
  helpImages.set(p, dataUrl);
  return { ok: true, message: "OK", dataUrl };
});
action("tech.firmware", "admin", () => cashier.firmware());
action("tech.settingFile", "admin", (name: string) => cashier.settingFile(String(name)));
action("tech.denomination", "admin", (cc: string, fv: string, devid: string, enabled: boolean) =>
  cashier.setDenomination(String(cc), String(fv), String(devid), !!enabled)
);
action("app.version", "public", () => app.getVersion());
// --- mises à jour automatiques
action("update.status", "public", () => updater.status());
action("update.check", "user", () => updater.check());
action("update.install", "user", () => {
  if (cashier.isBusy()) return { ok: false, message: "Une opération est en cours sur le terminal : réessayez une fois terminée." };
  return updater.installNow() ? { ok: true, message: "Installation de la mise à jour : le logiciel redémarre." } : { ok: false, message: "Aucune mise à jour prête." };
});
/** Recharge l'interface (changement de langue) : la page ne peut pas se recharger elle-même (navigation bloquée). */
action("app.reload", "public", () => {
  setTimeout(() => mainWindow?.webContents.reload(), 50);
  return { ok: true, message: "OK" };
});

ipcMain.handle(IpcChannels.Call, async (_e, name: string, ...args: unknown[]) => {
  const a = actions[name];
  if (!a) return { ok: false, message: `Action inconnue : ${name}` };
  // Sans licence valide, seul l'écran d'activation fonctionne (vérifié ici,
  // pas seulement dans l'interface).
  if (!name.startsWith("license.") && name !== "diag.rendererError" && name !== "app.reload" && name !== "fcc.state" && !name.startsWith("update.") && !license.isLicensed()) {
    return { ok: false, licenseRequired: true, message: "Licence requise." };
  }
  if (a.access !== "public" && !currentUser) return { ok: false, message: "Session expirée. Reconnectez-vous." };
  if (a.access === "admin" && currentUser?.role !== "admin") return { ok: false, message: "Action réservée à un administrateur." };
  try {
    return await (a.fn as (...x: unknown[]) => unknown)(...args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[ERREUR] ${name} : ${message}`);
    return { ok: false, message };
  }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // L'interface se met à l'échelle de la fenêtre (app.ts : applyZoom).
    minWidth: 640,
    minHeight: 480,
    title: "MedaCash",
    // Icône MedaCash (dans app.asar : le dossier build/ n'est pas livré).
    icon: path.join(__dirname, "..", "ui", "img", "app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "..", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Le preload sandboxé ne résout pas les require relatifs (vérifié le 2026-07-28).
      sandbox: false,
      devTools: !app.isPackaged,
      // Une caisse doit réagir tout de suite même fenêtre cachée ou réduite
      // (frappes, scanner, événements de paiement) : pas de ralentissement.
      backgroundThrottling: false,
    },
  });
  mainWindow.removeMenu();
  // Pas de navigation ni de fenêtre hors de l'application.
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void mainWindow.loadFile(path.join(__dirname, "..", "ui", "index.html"));
}

history.record("app-lifecycle", "start", { appStartedAt: APP_STARTED_AT, version: app.getVersion(), platform: `${process.platform} ${process.arch}` });

app.whenReady().then(() => {
  createWindow();
  void licenseCheck();
  updater.start();
});

/**
 * Libère proprement le terminal à la fermeture (avant : 65 Open pour 2
 * Close dans l'historique client). Ne couvre pas un arrêt brutal.
 */
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !cashier.isConnected()) return;
  event.preventDefault();
  quitting = true;
  void cashier.disconnect().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  history.record("app-lifecycle", "stop", { ts: new Date().toISOString() });
  history.close();
  ledger.close();
  if (process.platform !== "darwin") app.quit();
});
