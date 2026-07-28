/**
 * Script du renderer, compilé sans système de module (tsconfig.renderer.json)
 * et chargé via une balise <script> classique — pas besoin de bundler pour
 * cette UI. N'a accès qu'à `window.api`, exposé par src/main/preload.ts.
 */
type SessionState = "Closed" | "Open" | "Occupied" | "Released";

interface TransactionResult {
  ok: boolean;
  message: string;
  state: SessionState;
}

interface GloryClientApi {
  connect(): Promise<{ ok: boolean; message: string; state: SessionState }>;
  status(): Promise<{ ok: boolean; message: string; raw?: unknown; state: SessionState }>;
  disconnect(): Promise<{ ok: boolean; message: string; state: SessionState }>;
  startCashin(): Promise<TransactionResult>;
  endCashin(): Promise<TransactionResult>;
  change(amount: string): Promise<TransactionResult>;
  startReplenishEntrance(): Promise<TransactionResult>;
  endReplenishEntrance(): Promise<TransactionResult>;
  lockUnit(): Promise<TransactionResult>;
  unlockUnit(): Promise<TransactionResult>;
  inventory(): Promise<{ ok: boolean; message: string; raw?: unknown; state: SessionState }>;
  onLogLine(callback: (line: string) => void): void;
  onEvent(callback: (line: string) => void): void;
}

interface Window {
  api: GloryClientApi;
}

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

window.addEventListener("DOMContentLoaded", () => {
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

  window.api.onLogLine((line) => appendLine(logEl, line, classifyLogLine(line)));
  window.api.onEvent((line) => appendLine(eventsEl, line));

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    const result = await window.api.connect();
    appendLine(logEl, `[UI] Connecter → ${result.message}`, "tag-ui");
    setStatePill(result.state);
    connectBtn.disabled = false;
  });

  statusBtn.addEventListener("click", async () => {
    const result = await window.api.status();
    appendLine(logEl, `[UI] Statut → ${result.message}`, "tag-ui");
    statusEl.textContent = JSON.stringify(result.raw ?? {}, null, 2);
    setStatePill(result.state);
  });

  disconnectBtn.addEventListener("click", async () => {
    disconnectBtn.disabled = true;
    const result = await window.api.disconnect();
    appendLine(logEl, `[UI] Déconnecter → ${result.message}`, "tag-ui");
    setStatePill(result.state);
    disconnectBtn.disabled = false;
  });

  startCashinBtn.addEventListener("click", async () => {
    startCashinBtn.disabled = true;
    const result = await window.api.startCashin();
    appendLine(logEl, `[UI] Démarrer encaissement → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    startCashinBtn.disabled = false;
  });

  endCashinBtn.addEventListener("click", async () => {
    endCashinBtn.disabled = true;
    const result = await window.api.endCashin();
    appendLine(logEl, `[UI] Terminer encaissement → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    endCashinBtn.disabled = false;
  });

  changeBtn.addEventListener("click", async () => {
    const amount = amountInput.value.trim();
    if (!amount) {
      appendLine(logEl, "[UI] Encaisser (Change) → montant requis", "tag-error");
      return;
    }
    changeBtn.disabled = true;
    const result = await window.api.change(amount);
    appendLine(logEl, `[UI] Encaisser (Change, ${amount}) → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    changeBtn.disabled = false;
  });

  startReplenishBtn.addEventListener("click", async () => {
    startReplenishBtn.disabled = true;
    const result = await window.api.startReplenishEntrance();
    appendLine(logEl, `[UI] Démarrer remplissage → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    startReplenishBtn.disabled = false;
  });

  endReplenishBtn.addEventListener("click", async () => {
    endReplenishBtn.disabled = true;
    const result = await window.api.endReplenishEntrance();
    appendLine(logEl, `[UI] Terminer remplissage → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    endReplenishBtn.disabled = false;
  });

  lockBtn.addEventListener("click", async () => {
    lockBtn.disabled = true;
    const result = await window.api.lockUnit();
    appendLine(logEl, `[UI] Verrouiller → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    lockBtn.disabled = false;
  });

  unlockBtn.addEventListener("click", async () => {
    unlockBtn.disabled = true;
    const result = await window.api.unlockUnit();
    appendLine(logEl, `[UI] Déverrouiller → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    setStatePill(result.state);
    unlockBtn.disabled = false;
  });

  inventoryBtn.addEventListener("click", async () => {
    const result = await window.api.inventory();
    appendLine(logEl, `[UI] Inventaire → ${result.message}`, result.ok ? "tag-ui" : "tag-error");
    statusEl.textContent = JSON.stringify(result.raw ?? {}, null, 2);
    setStatePill(result.state);
  });
});
