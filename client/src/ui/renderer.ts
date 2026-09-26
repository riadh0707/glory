/**
 * Script du renderer, compilé sans système de module (tsconfig.renderer.json)
 * et chargé via une balise <script> classique — pas besoin de bundler pour
 * cette UI. N'a accès qu'à `window.api`, exposé par src/main/preload.ts.
 */
// Types partagés (SessionState, TransactionResult, GloryClientApi,
// Window.api) déclarés dans global.d.ts — voir ce fichier pour la raison.

function appendLine(container: HTMLElement, line: string, cssClass?: string): void {
  const row = document.createElement("div");
  row.className = `log-line${cssClass ? ` ${cssClass}` : ""}`;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date().toLocaleTimeString();
  row.appendChild(ts);
  row.appendChild(document.createTextNode(line));
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function classifyLogLine(line: string): string | undefined {
  if (line.startsWith("[ERREUR]") || line.includes("Échec")) return "tag-error";
  if (line.startsWith("[UI]")) return "tag-ui";
  if (line.startsWith("[SOAP →]")) return "dir-req";
  if (line.startsWith("[SOAP ←]")) return "dir-res";
  return undefined;
}

function setStatePill(state: SessionState): void {
  const pill = document.getElementById("state-pill") as HTMLSpanElement;
  const label = document.getElementById("state-label") as HTMLSpanElement;
  pill.className = `status-pill state-${state}`;
  label.textContent = state;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

/**
 * Regroupe des lignes de dénomination par devise/valeur faciale (peu importe
 * quel module — RBW/RCW — les détient : un utilisateur veut savoir "combien
 * de billets de 20€ au total", pas la répartition par cassette). `fv` est en
 * centimes (convention Glory usuelle, ex. fv="2000" = 20,00). Trié du plus
 * gros au plus petit montant, comme un tiroir-caisse compté à la main.
 */
function aggregateDenoms(lines: DenomLine[]): Array<{ cc: string; fv: string; piece: number }> {
  const map = new Map<string, { cc: string; fv: string; piece: number }>();
  for (const l of lines) {
    const key = `${l.cc}|${l.fv}`;
    const existing = map.get(key) ?? { cc: l.cc, fv: l.fv, piece: 0 };
    existing.piece += l.piece;
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => Number(b.fv) - Number(a.fv));
}

function formatAmount(fvCents: string | number): string {
  return (Number(fvCents) / 100).toFixed(2);
}

function denomTableHtml(lines: DenomLine[]): string {
  const aggregated = aggregateDenoms(lines);
  if (aggregated.length === 0) {
    return `<p class="muted">Aucune dénomination détectée.</p>`;
  }
  const totalsByCurrency = new Map<string, number>();
  const rows = aggregated
    .map((d) => {
      const value = (d.piece * Number(d.fv)) / 100;
      totalsByCurrency.set(d.cc, (totalsByCurrency.get(d.cc) ?? 0) + value);
      return `<tr><td>${escapeHtml(d.cc)}</td><td>${formatAmount(d.fv)}</td><td>${d.piece}</td><td>${value.toFixed(2)}</td></tr>`;
    })
    .join("");
  const footRows = [...totalsByCurrency.entries()]
    .map(([cc, total]) => `<tr><td colspan="3">Total ${escapeHtml(cc)}</td><td>${total.toFixed(2)}</td></tr>`)
    .join("");
  return `<table class="denom-table">
    <thead><tr><th>Devise</th><th>Valeur unitaire</th><th>Quantité</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>${footRows}</tfoot>
  </table>`;
}

function dayReportTableHtml(report: DayReportResponse): string {
  if (report.operations.length === 0) {
    return `<p class="muted">Aucune transaction enregistrée aujourd'hui (${escapeHtml(report.dateLabel)}).</p>`;
  }
  const rows = report.operations
    .map((op) => {
      const totals = Object.entries(op.totalsByCurrency)
        .map(([cc, total]) => `${total.toFixed(2)} ${cc}`)
        .join(", ") || "—";
      return `<tr><td>${escapeHtml(op.label)}</td><td>${op.count}</td><td>${escapeHtml(totals)}</td></tr>`;
    })
    .join("");
  const footRows = Object.entries(report.totalsByCurrency)
    .map(([cc, total]) => `<tr><td colspan="2">Total ${escapeHtml(cc)}</td><td>${total.toFixed(2)}</td></tr>`)
    .join("");
  return `<table class="op-table">
    <thead><tr><th>Opération</th><th>Nb</th><th>Montant</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>${footRows}</tfoot>
  </table>
  <p class="muted">${report.errorCount} erreur(s) aujourd'hui.</p>`;
}

/**
 * Remplit la zone d'impression cachée (`#print-area`, visible uniquement via
 * la règle `@media print` de styles.css) puis déclenche le dialogue
 * d'impression du système — laisse Windows/Linux/le navigateur choisir
 * l'imprimante, pas besoin d'intégration spécifique à un pilote (décision du
 * 2026-09-26, voir consigne client : "utilise celui de Windows, Linux ou du
 * navigateur qui va détecter le truc tout seul").
 */
function printHtml(title: string, bodyHtml: string): void {
  const area = document.getElementById("print-area") as HTMLDivElement;
  area.innerHTML = `<h1>${escapeHtml(title)}</h1><p>${new Date().toLocaleString()}</p>${bodyHtml}`;
  window.print();
}

window.addEventListener("DOMContentLoaded", () => {
  const appEl = document.querySelector(".app") as HTMLDivElement;
  const logEl = document.getElementById("log") as HTMLDivElement;
  const eventsEl = document.getElementById("events") as HTMLDivElement;
  const statusEl = document.getElementById("status-output") as HTMLPreElement;
  const connectBtn = document.getElementById("btn-connect") as HTMLButtonElement;
  const statusBtn = document.getElementById("btn-status") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("btn-disconnect") as HTMLButtonElement;
  const startCashinBtn = document.getElementById("btn-start-cashin") as HTMLButtonElement;
  const endCashinBtn = document.getElementById("btn-end-cashin") as HTMLButtonElement;
  const changeBtn = document.getElementById("btn-change") as HTMLButtonElement;
  const amountInput = document.getElementById("input-amount") as HTMLInputElement;
  const startReplenishBtn = document.getElementById("btn-start-replenish") as HTMLButtonElement;
  const endReplenishBtn = document.getElementById("btn-end-replenish") as HTMLButtonElement;
  const lockBtn = document.getElementById("btn-lock") as HTMLButtonElement;
  const unlockBtn = document.getElementById("btn-unlock") as HTMLButtonElement;
  const inventoryBtn = document.getElementById("btn-inventory") as HTMLButtonElement;
  const printInventoryBtn = document.getElementById("btn-print-inventory") as HTMLButtonElement;
  const inventoryTableEl = document.getElementById("inventory-table") as HTMLDivElement;
  const openExitCoverBtn = document.getElementById("btn-open-exit-cover") as HTMLButtonElement;
  const closeExitCoverBtn = document.getElementById("btn-close-exit-cover") as HTMLButtonElement;
  const romVersionBtn = document.getElementById("btn-rom-version") as HTMLButtonElement;
  const adjustTimeBtn = document.getElementById("btn-adjust-time") as HTMLButtonElement;
  const getSettingFileBtn = document.getElementById("btn-get-setting-file") as HTMLButtonElement;
  const settingFileNameInput = document.getElementById("input-setting-filename") as HTMLInputElement;
  const enableDenomBtn = document.getElementById("btn-enable-denom") as HTMLButtonElement;
  const disableDenomBtn = document.getElementById("btn-disable-denom") as HTMLButtonElement;
  const denomCcInput = document.getElementById("input-denom-cc") as HTMLInputElement;
  const denomFvInput = document.getElementById("input-denom-fv") as HTMLInputElement;
  const denomDevidInput = document.getElementById("input-denom-devid") as HTMLInputElement;
  const setExchangeRateBtn = document.getElementById("btn-set-exchange-rate") as HTMLButtonElement;
  const exchangeFromInput = document.getElementById("input-exchange-from") as HTMLInputElement;
  const exchangeToInput = document.getElementById("input-exchange-to") as HTMLInputElement;
  const exchangeRateInput = document.getElementById("input-exchange-rate") as HTMLInputElement;
  const resetBtn = document.getElementById("btn-reset") as HTMLButtonElement;
  const cashinCancelBtn = document.getElementById("btn-cashin-cancel") as HTMLButtonElement;
  const changeCancelBtn = document.getElementById("btn-change-cancel") as HTMLButtonElement;
  const replenishCancelBtn = document.getElementById("btn-replenish-entrance-cancel") as HTMLButtonElement;
  const returnCashBtn = document.getElementById("btn-return-cash") as HTMLButtonElement;
  const cashoutBtn = document.getElementById("btn-cashout") as HTMLButtonElement;
  const cashoutCcInput = document.getElementById("input-cashout-cc") as HTMLInputElement;
  const cashoutFvInput = document.getElementById("input-cashout-fv") as HTMLInputElement;
  const cashoutDevidInput = document.getElementById("input-cashout-devid") as HTMLInputElement;
  const cashoutPieceInput = document.getElementById("input-cashout-piece") as HTMLInputElement;
  const generateReportBtn = document.getElementById("btn-generate-report") as HTMLButtonElement;
  const dayReportBtn = document.getElementById("btn-day-report") as HTMLButtonElement;
  const printDayReportBtn = document.getElementById("btn-print-day-report") as HTMLButtonElement;
  const dayReportTableEl = document.getElementById("day-report-table") as HTMLDivElement;
  const printReceiptBtn = document.getElementById("btn-print-receipt") as HTMLButtonElement;
  const toggleTechBtn = document.getElementById("btn-toggle-tech") as HTMLButtonElement;
  const soapEndpointInput = document.getElementById("input-soap-endpoint") as HTMLInputElement;
  const callbackIpInput = document.getElementById("input-callback-ip") as HTMLInputElement;
  const eventPortInput = document.getElementById("input-event-port") as HTMLInputElement;
  const rejectUnauthorizedInput = document.getElementById("input-reject-unauthorized") as HTMLInputElement;
  const userIdInput = document.getElementById("input-user-id") as HTMLInputElement;
  const userPwdInput = document.getElementById("input-user-pwd") as HTMLInputElement;

  let lastInventoryLines: DenomLine[] = [];
  let lastDayReport: DayReportResponse | null = null;
  let lastReceiptHtml = `<p class="muted">Aucune opération d'encaissement effectuée pour l'instant.</p>`;

  // Préférence d'affichage locale au navigateur (pas de synchronisation
  // multi-poste nécessaire) — mémorise si le mode technique était ouvert,
  // pour ne pas avoir à le rebasculer à chaque redémarrage de l'app.
  try {
    if (localStorage.getItem("glory-tech-mode") === "1") {
      appEl.classList.add("tech-on");
    }
  } catch {
    // Stockage indisponible (profil restreint) — le mode technique reste
    // simplement désactivé par défaut, sans bloquer le reste de l'UI.
  }

  toggleTechBtn.addEventListener("click", () => {
    const isOn = appEl.classList.toggle("tech-on");
    try {
      localStorage.setItem("glory-tech-mode", isOn ? "1" : "0");
    } catch {
      // Ignoré (voir ci-dessus) — la préférence ne survivra pas au
      // redémarrage, sans conséquence fonctionnelle.
    }
  });

  window.api.onLogLine((line) => appendLine(logEl, line, classifyLogLine(line)));
  window.api.onEvent((line) => appendLine(eventsEl, line));

  // Préremplit les champs de connexion avec la config actuelle (valeurs par
  // défaut de model-adapter/ci-10.ts, ou la dernière config sauvegardée dans
  // userData/fcc-config.json — voir core/fcc-config).
  void window.api.fccConfigGet().then((config) => {
    soapEndpointInput.value = config.soapEndpoint;
    callbackIpInput.value = config.callbackIp;
    eventPortInput.value = String(config.eventTcpPort);
    rejectUnauthorizedInput.checked = config.rejectUnauthorized;
    userIdInput.value = config.userId;
    userPwdInput.value = config.userPwd;
  });

  /**
   * Capture globale des erreurs renderer (exceptions JS synchrones et
   * promesses rejetées non gérées) — sans ça, un bug purement UI ne laisse
   * aucune trace exploitable (voir docs/development-notes.md, incident du
   * 2026-07-29 : un clic rapide sur "Déconnecter" laissait le bouton bloqué
   * sans qu'aucune ligne d'erreur n'apparaisse nulle part). Remonté au
   * processus main pour atterrir dans le même rapport de diagnostic que les
   * erreurs SOAP.
   */
  window.addEventListener("error", (event) => {
    void window.api.reportRendererError("window.onerror", event.message, event.error?.stack);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    void window.api.reportRendererError("unhandledrejection", message, stack);
  });

  /**
   * Enveloppe chaque clic : désactive le bouton, exécute `fn`, le
   * réactive TOUJOURS (`finally`) même si `fn` lève une exception — avant
   * ce correctif (2026-07-29), une exception dans un handler laissait le
   * bouton désactivé indéfiniment et l'erreur n'était visible nulle part
   * (ni dans le journal, ni dans un rapport). L'erreur est maintenant
   * affichée ET remontée au processus main pour le rapport de diagnostic.
   */
  function guardedClick(btn: HTMLButtonElement, label: string, fn: () => Promise<void>): void {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        appendLine(logEl, `[ERREUR] (UI) ${label} : ${message}`, "tag-error");
        void window.api.reportRendererError(label, message, stack);
      } finally {
        btn.disabled = false;
      }
    });
  }

  /** Met à jour la zone imprimable "reçu" après une opération d'encaissement
   * (Démarrer/Terminer/Change/Annuler) — le client peut imprimer ce résumé
   * juste après l'opération sans avoir à ouvrir le mode technique. */
  function recordReceipt(label: string, message: string, ok: boolean): void {
    lastReceiptHtml = `
      <table class="op-table">
        <tbody>
          <tr><td>Opération</td><td>${escapeHtml(label)}</td></tr>
          <tr><td>Résultat</td><td>${ok ? "OK" : "Échec"}</td></tr>
          <tr><td>Détail</td><td>${escapeHtml(message)}</td></tr>
        </tbody>
      </table>`;
  }

  guardedClick(connectBtn, "Connecter", async () => {
    // Sauvegarde la config de connexion saisie AVANT de se connecter — le
    // processus main la relit à chaque appel de connect() (voir
    // core/fcc-config, main.ts handleConnect). Permet de pointer vers un
    // vrai FCC sans reconstruire l'app.
    const eventTcpPort = Number(eventPortInput.value.trim()) || 55561;
    await window.api.fccConfigSave({
      soapEndpoint: soapEndpointInput.value.trim(),
      callbackIp: callbackIpInput.value.trim(),
      eventTcpPort,
      rejectUnauthorized: rejectUnauthorizedInput.checked,
      userId: userIdInput.value.trim(),
      userPwd: userPwdInput.value,
    });
    const result = await window.api.connect();
    appendLine(logEl, `[UI] Connecter → ${result.message}`, "tag-ui");
    setStatePill(result.state);
  });

  statusBtn.addEventListener("click", async () => {
    try {
      const result = await window.api.status();
      appendLine(logEl, `[UI] Statut → ${result.message}`, "tag-ui");
      statusEl.textContent = JSON.stringify(result.raw ?? {}, null, 2);
      setStatePill(result.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logEl, `[ERREUR] (UI) Statut : ${message}`, "tag-error");
      void window.api.reportRendererError("Statut", message, err instanceof Error ? err.stack : undefined);
    }
  });

  guardedClick(disconnectBtn, "Déconnecter", async () => {
    const result = await window.api.disconnect();
    appendLine(logEl, `[UI] Déconnecter → ${result.message}`, "tag-ui");
    setStatePill(result.state);
  });

  guardedClick(startCashinBtn, "Démarrer encaissement", async () => {
    const result = await window.api.startCashin();
    appendLine(logEl, `[UI] Démarrer encaissement → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    recordReceipt("Démarrer encaissement", result.message, result.ok);
    setStatePill(result.state);
  });

  guardedClick(endCashinBtn, "Terminer encaissement", async () => {
    const result = await window.api.endCashin();
    appendLine(logEl, `[UI] Terminer encaissement → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    recordReceipt("Terminer encaissement", result.message, result.ok);
    setStatePill(result.state);
  });

  guardedClick(changeBtn, "Encaisser (Change)", async () => {
    const amount = amountInput.value.trim();
    if (!amount) {
      appendLine(logEl, "[UI] Encaisser (Change) → montant requis", "tag-error");
      return;
    }
    const result = await window.api.change(amount);
    appendLine(logEl, `[UI] Encaisser (Change, ${amount}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    recordReceipt(`Encaisser (Change, ${amount})`, result.message, result.ok);
    setStatePill(result.state);
  });

  guardedClick(cashinCancelBtn, "Annuler l'encaissement", async () => {
    const result = await window.api.cashinCancel();
    appendLine(logEl, `[UI] Annuler encaissement → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    recordReceipt("Annuler l'encaissement", result.message, result.ok);
    setStatePill(result.state);
  });

  printReceiptBtn.addEventListener("click", () => {
    printHtml("Reçu — Glory FCC Client", lastReceiptHtml);
  });

  guardedClick(startReplenishBtn, "Démarrer remplissage", async () => {
    const result = await window.api.startReplenishEntrance();
    appendLine(logEl, `[UI] Démarrer remplissage → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(endReplenishBtn, "Terminer remplissage", async () => {
    const result = await window.api.endReplenishEntrance();
    appendLine(logEl, `[UI] Terminer remplissage → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(replenishCancelBtn, "Annuler remplissage (entrée)", async () => {
    const result = await window.api.replenishEntranceCancel();
    appendLine(logEl, `[UI] Annuler remplissage (entrée) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(lockBtn, "Verrouiller", async () => {
    const result = await window.api.lockUnit();
    appendLine(logEl, `[UI] Verrouiller → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(unlockBtn, "Déverrouiller", async () => {
    const result = await window.api.unlockUnit();
    appendLine(logEl, `[UI] Déverrouiller → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(openExitCoverBtn, "Ouvrir couvercle sortie", async () => {
    const result = await window.api.openExitCover();
    appendLine(logEl, `[UI] Ouvrir couvercle sortie → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(closeExitCoverBtn, "Fermer couvercle sortie", async () => {
    const result = await window.api.closeExitCover();
    appendLine(logEl, `[UI] Fermer couvercle sortie → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(resetBtn, "Reset", async () => {
    appendLine(logEl, "[UI] Reset → en cours (peut prendre jusqu'à ~30s)...", "tag-ui");
    const result = await window.api.reset();
    appendLine(logEl, `[UI] Reset → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  inventoryBtn.addEventListener("click", async () => {
    try {
      const result = await window.api.inventory();
      appendLine(logEl, `[UI] Inventaire → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
      statusEl.textContent = JSON.stringify(result.raw ?? {}, null, 2);
      lastInventoryLines = result.lines ?? [];
      inventoryTableEl.innerHTML = denomTableHtml(lastInventoryLines);
      printInventoryBtn.disabled = false;
      setStatePill(result.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logEl, `[ERREUR] (UI) Inventaire : ${message}`, "tag-error");
      void window.api.reportRendererError("Inventaire", message, err instanceof Error ? err.stack : undefined);
    }
  });

  printInventoryBtn.addEventListener("click", () => {
    printHtml("Inventaire — Glory FCC Client", denomTableHtml(lastInventoryLines));
  });

  dayReportBtn.addEventListener("click", async () => {
    try {
      const report = await window.api.dayReport();
      appendLine(logEl, `[UI] Rapport du jour → ${report.message}`, "tag-ui");
      lastDayReport = report;
      dayReportTableEl.innerHTML = dayReportTableHtml(report);
      printDayReportBtn.disabled = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logEl, `[ERREUR] (UI) Rapport du jour : ${message}`, "tag-error");
      void window.api.reportRendererError("Rapport du jour", message, err instanceof Error ? err.stack : undefined);
    }
  });

  printDayReportBtn.addEventListener("click", () => {
    if (!lastDayReport) return;
    printHtml(`Rapport du jour — ${lastDayReport.dateLabel}`, dayReportTableHtml(lastDayReport));
  });

  romVersionBtn.addEventListener("click", async () => {
    try {
      const result = await window.api.romVersion();
      appendLine(logEl, `[UI] Versions firmware → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
      statusEl.textContent = JSON.stringify(result.raw ?? {}, null, 2);
      setStatePill(result.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLine(logEl, `[ERREUR] (UI) Versions firmware : ${message}`, "tag-error");
      void window.api.reportRendererError("Versions firmware", message, err instanceof Error ? err.stack : undefined);
    }
  });

  guardedClick(adjustTimeBtn, "Régler date/heure", async () => {
    const result = await window.api.adjustTime();
    appendLine(logEl, `[UI] Régler date/heure (heure système) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(getSettingFileBtn, "Lire fichier config", async () => {
    const fileName = settingFileNameInput.value.trim();
    if (!fileName) {
      appendLine(logEl, "[UI] Lire fichier config → nom de fichier requis", "tag-error");
      return;
    }
    const result = await window.api.getSettingFile(fileName);
    appendLine(logEl, `[UI] Lire fichier config (${fileName}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    statusEl.textContent = typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw ?? {}, null, 2);
    setStatePill(result.state);
  });

  function readDenomInputs(): { cc: string; fv: string; devid: string } | undefined {
    const cc = denomCcInput.value.trim();
    const fv = denomFvInput.value.trim();
    const devid = denomDevidInput.value.trim();
    if (!cc || !fv || !devid) {
      appendLine(logEl, "[UI] Dénomination → cc/fv/devid requis (ex. EUR / 2000 / 1)", "tag-error");
      return undefined;
    }
    return { cc, fv, devid };
  }

  guardedClick(enableDenomBtn, "Autoriser dénomination", async () => {
    const params = readDenomInputs();
    if (!params) return;
    const result = await window.api.enableDenom(params);
    appendLine(logEl, `[UI] Autoriser dénomination (${params.cc} ${params.fv}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(disableDenomBtn, "Interdire dénomination", async () => {
    const params = readDenomInputs();
    if (!params) return;
    const result = await window.api.disableDenom(params);
    appendLine(logEl, `[UI] Interdire dénomination (${params.cc} ${params.fv}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(setExchangeRateBtn, "Taux de change", async () => {
    const from = exchangeFromInput.value.trim();
    const to = exchangeToInput.value.trim();
    const rate = exchangeRateInput.value.trim();
    if (!from || !to || !rate) {
      appendLine(logEl, "[UI] Taux de change → devise source/cible/taux requis", "tag-error");
      return;
    }
    const result = await window.api.setExchangeRate({ from, to, rate });
    appendLine(logEl, `[UI] Taux de change (${from}→${to}=${rate}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(changeCancelBtn, "Annuler Change en attente", async () => {
    const result = await window.api.changeCancel();
    appendLine(logEl, `[UI] Annuler Change (en attente) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(returnCashBtn, "Renvoyer pièces", async () => {
    const result = await window.api.returnCash();
    appendLine(logEl, `[UI] Renvoyer pièces (hopper→sortie) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(cashoutBtn, "Cashout", async () => {
    const cc = cashoutCcInput.value.trim();
    const fv = cashoutFvInput.value.trim();
    const devid = cashoutDevidInput.value.trim();
    const piece = Number(cashoutPieceInput.value.trim());
    if (!cc || !fv || !devid || !piece) {
      appendLine(logEl, "[UI] Cashout → cc/fv/devid/nombre de pièces requis", "tag-error");
      return;
    }
    const result = await window.api.cashout({ cc, fv, devid, piece });
    appendLine(logEl, `[UI] Cashout (${cc} ${fv} x${piece}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
  });

  guardedClick(generateReportBtn, "Générer rapport de diagnostic", async () => {
    const result = await window.api.generateDiagnosticReport();
    appendLine(logEl, `[UI] Rapport de diagnostic → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
  });
});
