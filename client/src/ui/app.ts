/**
 * Ossature de l'interface : connexion utilisateur, navigation, état du
 * terminal, flux d'événements. Les écrans eux-mêmes sont dans screens.ts.
 */

interface MachineStatus {
  status: number;
  label: string;
  amountCents: number;
}

const S = {
  user: null as PublicUser | null,
  cashier: { connection: "disconnected", sessionMode: false, occupyMode: false, busy: null } as CashierState,
  machine: null as MachineStatus | null,
  receipt: null as ReceiptSettings | null,
  settings: null as AppSettings | null,
  screen: "sale",
  logs: [] as string[],
  events: [] as string[],
  lastActivity: Date.now(),
  /** Dernier HeartBeatEvent reçu (le terminal en envoie toutes les ~20 s). 0 = jamais reçu. */
  lastHeartbeat: 0,
};

type ScreenDef = { id: string; label: string; icon: string; admin?: boolean; render: (root: HTMLElement) => void | Promise<void> };

/** Abonnements aux événements terminal propres à l'écran affiché (vidés au changement d'écran). */
let screenListeners: Array<(e: FccEvent) => void> = [];
function onFcc(fn: (e: FccEvent) => void): void {
  screenListeners.push(fn);
}

const ICONS: Record<string, string> = {
  sale: '<path d="M3 7h18v10H3z"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v4M18 10v4"/>',
  stock: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  ops: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  manage: '<path d="M4 20V10l8-6 8 6v10"/><path d="M9 20v-6h6v6"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  stats: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
  maint: '<path d="M14.5 6.5a4 4 0 0 0 3.9 5L11 19a2.1 2.1 0 0 1-3-3l7.5-7.4a4 4 0 0 0-1-2.1z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  deposit: '<path d="M12 3v11M7.5 9.5L12 14l4.5-4.5"/><path d="M4 15v4h16v-4"/>',
  exchange: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
  payout: '<path d="M12 14V3M7.5 7.5L12 3l4.5 4.5"/><path d="M4 15v4h16v-4"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  refill: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M12 10.5v6M9 13.5h6M8 7V4h8v3"/>',
  collect: '<path d="M3 7h18v13H3z"/><path d="M3 7l3-4h12l3 4M9 12h6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  door: '<path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17"/><path d="M3 21h18M14 12h.01"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

// ------------------------------------------------------------------ démarrage

window.addEventListener("error", (e) => {
  void window.api.call("diag.rendererError", "window.onerror", e.message, e.error?.stack);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  void window.api.call("diag.rendererError", "unhandledrejection", r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
});

window.addEventListener("DOMContentLoaded", () => {
  window.api.onLog((line) => {
    S.logs.push(`${new Date().toLocaleTimeString("fr-BE")}  ${line}`);
    if (S.logs.length > 1500) S.logs.splice(0, S.logs.length - 1500);
    const pane = document.getElementById("tech-log");
    if (pane) appendPaneLine(pane, S.logs[S.logs.length - 1]);
  });
  window.api.onState((s) => {
    if (s.connection !== "connected") S.lastHeartbeat = 0;
    S.cashier = s;
    renderStatusChip();
  });
  window.api.onFccEvent((e) => {
    if (e.kind === "heartbeat") {
      const wasLost = isSignalLost();
      S.lastHeartbeat = Date.now();
      if (wasLost) renderStatusChip();
    }
    if (e.kind === "status") {
      S.machine = { status: e.status, label: e.label, amountCents: e.amountCents };
      renderStatusChip();
    }
    if (e.kind === "unit" && ["eventFull", "eventEmpty", "eventMissing", "eventHigh"].includes(e.name)) {
      toast(`${e.devid === "2" ? "Module pièces" : "Module billets"} : ${e.label}`, e.name === "eventHigh" ? "info" : "error");
    }
    if (e.kind === "error") toast(`Erreur terminal (${e.devid === "2" ? "pièces" : "billets"})`, "error");
    if (e.kind !== "heartbeat") {
      S.events.push(`${new Date().toLocaleTimeString("fr-BE")}  ${JSON.stringify(e)}`);
      if (S.events.length > 500) S.events.shift();
      const pane = document.getElementById("tech-events");
      if (pane) appendPaneLine(pane, S.events[S.events.length - 1]);
    }
    for (const fn of screenListeners) fn(e);
  });

  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => (S.lastActivity = Date.now()), true);
  setInterval(checkAutoLock, 15_000);
  setInterval(renderStatusChip, 15_000);
  setInterval(() => {
    const c = document.getElementById("clock");
    if (c) c.textContent = new Date().toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" });
  }, 10_000);

  void showLogin();
});

function appendPaneLine(pane: HTMLElement, line: string): void {
  const div = document.createElement("div");
  div.textContent = line;
  if (line.includes("[ERREUR]")) div.className = "log-err";
  pane.appendChild(div);
  if (pane.childElementCount > 1500) pane.firstElementChild?.remove();
  pane.scrollTop = pane.scrollHeight;
}

function checkAutoLock(): void {
  const minutes = S.settings?.autoLockMinutes ?? 0;
  if (!S.user || minutes <= 0 || S.cashier.busy) return;
  if (Date.now() - S.lastActivity > minutes * 60_000) void logout();
}

// ------------------------------------------------------------------ connexion utilisateur

async function showLogin(): Promise<void> {
  const users = await window.api.call<PublicUser[]>("users.list");
  const root = $("#app");
  root.className = "login-shell";
  if (users.length === 0) return showSetup(root);

  root.innerHTML = `<div class="login-card">
      <div class="login-brand"><div class="brand-mark">G</div><div><h1>Glory FCC</h1><p>Choisissez votre profil</p></div></div>
      <div class="user-grid">${users
        .map((u) => `<button class="user-tile" data-u="${esc(u.name)}"><span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span><span>${esc(u.name)}</span><small>${u.role === "admin" ? "Administrateur" : "Vendeur"}</small></button>`)
        .join("")}</div>
      <div class="pin-step" hidden>
        <p class="pin-who"></p>
        <div class="pin-dots"></div>
        <div class="pin-pad"></div>
        <div class="login-actions"><button class="btn" data-back>Retour</button><button class="btn btn-primary" data-go>Valider</button></div>
      </div>
      <p class="login-version" id="version"></p>
    </div>`;
  void window.api.call<string>("app.version").then((v) => ($("#version").textContent = `Version ${v}`));

  let selected = "";
  const step = $(".pin-step", root);
  const dots = $(".pin-dots", root);
  const pad = keypad($(".pin-pad", root), {
    mode: "pin",
    onChange: (v) => (dots.innerHTML = Array.from({ length: Math.max(4, v.length) }, (_, i) => `<span class="${i < v.length ? "on" : ""}"></span>`).join("")),
    onEnter: () => void submit(),
  });
  pad.set("");

  const submit = async () => {
    if (!selected || pad.value().length < 4) return;
    const r = await window.api.call<{ ok: boolean; message?: string; user?: PublicUser }>("users.login", selected, pad.value());
    if (!r.ok || !r.user) {
      pad.set("");
      dots.classList.add("shake");
      setTimeout(() => dots.classList.remove("shake"), 400);
      toast(r.message ?? "Code incorrect.", "error");
      return;
    }
    S.user = r.user;
    await enterApp();
  };

  for (const b of $$<HTMLButtonElement>(".user-tile", root)) {
    b.addEventListener("click", () => {
      selected = b.dataset.u!;
      $(".user-grid", root).hidden = true;
      step.hidden = false;
      $(".pin-who", root).textContent = `Code PIN de ${selected}`;
      pad.set("");
    });
  }
  $("[data-back]", root).addEventListener("click", () => {
    selected = "";
    step.hidden = true;
    $(".user-grid", root).hidden = false;
  });
  $("[data-go]", root).addEventListener("click", () => void submit());
  if (users.length === 1) ($(".user-tile", root) as HTMLButtonElement).click();
}

function showSetup(root: HTMLElement): void {
  root.innerHTML = `<div class="login-card">
    <div class="login-brand"><div class="brand-mark">G</div><div><h1>Bienvenue</h1><p>Créez le compte administrateur</p></div></div>
    <form class="form setup-form">
      <label>Nom<input name="name" required maxlength="40" autocomplete="off" value="Administrateur"></label>
      <label>Code PIN (4 à 8 chiffres)<input name="pin" type="password" inputmode="numeric" required pattern="\\d{4,8}"></label>
      <label>Confirmer le code PIN<input name="pin2" type="password" inputmode="numeric" required pattern="\\d{4,8}"></label>
      <button class="btn btn-primary btn-lg">Créer et continuer</button>
    </form></div>`;
  const form = $<HTMLFormElement>(".setup-form", root);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get("name")).trim();
    const pin = String(fd.get("pin"));
    if (pin !== String(fd.get("pin2"))) return toast("Les deux codes PIN ne correspondent pas.", "error");
    const r = await window.api.call("users.setupFirstAdmin", name, pin);
    if (!r.ok) return void toast(r.message, "error");
    toast("Compte créé.", "ok");
    void showLogin();
  });
}

async function logout(): Promise<void> {
  await window.api.call("users.logout");
  S.user = null;
  screenListeners = [];
  await showLogin();
}

// ------------------------------------------------------------------ application

async function enterApp(): Promise<void> {
  S.receipt = await window.api.call<ReceiptSettings>("settings.receiptGet");
  S.settings = await window.api.call<AppSettings>("settings.appGet");
  S.lastActivity = Date.now();
  renderShell();
  goTo("sale");
  if (S.settings.autoConnect && S.cashier.connection === "disconnected") void connectTerminal();
}

async function connectTerminal(btn?: HTMLButtonElement): Promise<void> {
  await busy(btn ?? null, async () => {
    const r = await window.api.call("fcc.connect");
    if (r.ok) toast("Terminal connecté.", "ok");
    else toast(r.message, "error");
  });
}

function visibleScreens(): ScreenDef[] {
  return SCREENS.filter((s) => !s.admin || S.user?.role === "admin");
}

function renderShell(): void {
  const root = $("#app");
  root.className = "shell";
  root.innerHTML = `
    <aside class="rail">
      <div class="rail-brand"><div class="brand-mark">G</div><span>${esc(S.receipt?.companyName || "Glory FCC")}</span></div>
      <nav class="rail-nav">${visibleScreens()
        .map((s) => `<button class="rail-item" data-screen="${s.id}">${icon(s.icon)}<span>${esc(s.label)}</span></button>`)
        .join("")}</nav>
      <div class="rail-foot">
        <div class="rail-user"><span class="avatar">${esc(S.user!.name.slice(0, 1).toUpperCase())}</span><div><strong>${esc(S.user!.name)}</strong><small>${S.user!.role === "admin" ? "Administrateur" : "Vendeur"}</small></div></div>
        <button class="btn btn-ghost btn-block" id="btn-logout">Changer d'utilisateur</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="topbar-title"><h1 id="screen-title"></h1><span class="topbar-date">${esc(longDate())}</span></div>
        <div class="topbar-right">
          <div class="conn">
            <button id="status-chip" class="chip" aria-haspopup="true" aria-expanded="false"></button>
            <div class="conn-pop" id="conn-pop" hidden>
              <p class="conn-title" id="conn-title"></p>
              <p class="muted small" id="conn-detail"></p>
              <button class="btn btn-block" id="btn-conn"></button>
            </div>
          </div>
          <span class="clock" id="clock">${new Date().toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </header>
      <main id="screen" class="screen"></main>
    </div>`;
  for (const b of $$<HTMLButtonElement>(".rail-item", root)) b.addEventListener("click", () => goTo(b.dataset.screen!));
  $("#btn-logout").addEventListener("click", () => void logout());
  const pop = $("#conn-pop");
  const chip = $("#status-chip");
  const closePop = () => {
    pop.hidden = true;
    chip.setAttribute("aria-expanded", "false");
  };
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    chip.setAttribute("aria-expanded", String(!pop.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !(e.target as HTMLElement).closest(".conn")) closePop();
  });
  $("#btn-conn").addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    if (S.cashier.connection === "connected") {
      if (S.cashier.busy && !(await confirmDialog("Opération en cours", `« ${S.cashier.busy} » est en cours. Déconnecter quand même ?`, "Déconnecter", true))) return;
      await busy(b, async () => report(await window.api.call("fcc.disconnect")));
    } else await connectTerminal(b);
    closePop();
    if (S.screen === "sale") goTo("sale");
  });
  renderStatusChip();
}

/** Plus de signal depuis 70 s alors qu'on en recevait : câble, réseau ou terminal éteint. */
function isSignalLost(): boolean {
  return S.cashier.connection === "connected" && S.lastHeartbeat > 0 && Date.now() - S.lastHeartbeat > 70_000;
}

function renderStatusChip(): void {
  const chip = document.getElementById("status-chip");
  const btn = document.getElementById("btn-conn") as HTMLButtonElement | null;
  if (!chip || !btn) return;
  const c = S.cashier;
  let text = "Terminal déconnecté";
  let cls = "chip chip-off";
  if (c.connection === "connecting") {
    text = "Connexion…";
    cls = "chip chip-warn";
  } else if (c.connection === "connected") {
    const m = S.machine;
    text = c.busy ? `${c.busy} en cours…` : m && m.status !== 1 ? m.label : "Terminal prêt";
    cls = c.busy || (m && m.status !== 1) ? "chip chip-busy" : "chip chip-ok";
    if (m && (m.status === 13 || m.status === 30)) cls = "chip chip-err";
    if (isSignalLost()) {
      text = "Pas de signal du terminal";
      cls = "chip chip-err";
    }
  }
  chip.className = cls;
  chip.innerHTML = `<span class="dot"></span><span class="chip-text">${esc(text)}</span><svg class="chip-caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>`;
  btn.textContent = c.connection === "connected" ? "Déconnecter le terminal" : "Connecter le terminal";
  btn.className = c.connection === "connected" ? "btn btn-block btn-danger" : "btn btn-block btn-primary";
  btn.disabled = c.connection === "connecting";
  const title = document.getElementById("conn-title");
  const detail = document.getElementById("conn-detail");
  if (title && detail) {
    title.textContent = text;
    detail.textContent =
      c.connection === "connected"
        ? [c.sessionMode ? "Mode session" : "Sans session", c.occupyMode ? "réservé à cette caisse" : "accès partagé", S.lastHeartbeat ? `dernier signal à ${new Date(S.lastHeartbeat).toLocaleTimeString("fr-BE")}` : ""]
            .filter(Boolean)
            .join(" · ")
        : "Le terminal n'est pas joignable par l'application.";
  }
}

function goTo(id: string): void {
  const def = visibleScreens().find((s) => s.id === id) ?? visibleScreens()[0];
  S.screen = def.id;
  screenListeners = [];
  for (const b of $$(".rail-item")) b.classList.toggle("active", b.dataset.screen === def.id);
  $("#screen-title").textContent = def.label;
  const root = $("#screen");
  root.innerHTML = "";
  root.scrollTop = 0;
  void def.render(root);
}

/** Garde-fou commun aux écrans qui ont besoin du terminal. */
function requireConnected(root: HTMLElement): boolean {
  if (S.cashier.connection === "connected") return true;
  root.innerHTML = `<div class="empty">
    <h2>Terminal non connecté</h2>
    <p>Connectez le terminal pour utiliser cet écran.</p>
    <button class="btn btn-primary btn-lg" id="empty-connect">Connecter le terminal</button></div>`;
  $("#empty-connect", root).addEventListener("click", async (e) => {
    await connectTerminal(e.currentTarget as HTMLButtonElement);
    if (S.cashier.connection === "connected") goTo(S.screen);
  });
  return false;
}
