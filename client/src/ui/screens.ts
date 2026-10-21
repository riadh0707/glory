/**
 * Écrans de l'application. Chaque `render` reçoit le conteneur vide de
 * l'écran ; les abonnements aux événements terminal passent par `onFcc`
 * (nettoyés automatiquement au changement d'écran).
 */

const SCREENS: ScreenDef[] = [
  { id: "sale", label: "Vente", icon: "sale", render: renderSale },
  { id: "stock", label: "Encaisse", icon: "stock", render: renderStock },
  { id: "ops", label: "Opérations", icon: "ops", render: renderOps },
  { id: "manage", label: "Gestion", icon: "manage", admin: true, render: renderManage },
  { id: "history", label: "Historique", icon: "history", render: renderHistory },
  { id: "stats", label: "Statistiques", icon: "stats", render: renderStats },
  { id: "maint", label: "Maintenance", icon: "maint", render: renderMaint },
  { id: "settings", label: "Réglages", icon: "settings", admin: true, render: renderSettings },
];

async function printMoneyTicket(title: string, r: MoneyResult, extra: TicketLine[] = []): Promise<void> {
  const s = S.receipt ?? (await window.api.call<ReceiptSettings>("settings.receiptGet"));
  const ticketNo = await window.api.call<number>("ticket.next");
  if (r.transactionId) await window.api.call("ticket.attach", r.transactionId, ticketNo);
  const lines: TicketLine[] = [...extra];
  if (r.inCents) lines.push({ label: "Espèces reçues", value: money(r.inCents) });
  if (r.outCents) lines.push({ label: r.dueCents !== undefined && r.inCents ? "Rendu" : "Sorti", value: money(r.outCents) });
  printTicket(ticketHtml(s, title, ticketNo, lines, { barcodeCents: r.dueCents ?? r.inCents ?? r.outCents, user: S.user?.name }), s.paperFormat);
}

/** Bloc « détail des espèces » (billets/pièces dessinés). */
function cashDetail(lines: DenomLine[]): string {
  const agg = aggregateLines(lines).filter((l) => l.piece > 0);
  if (agg.length === 0) return `<p class="muted">Aucune</p>`;
  return `<div class="cash-chips">${agg.map((l) => `<span class="cash-chip">${cashHtml(l, "sm")}<b>× ${l.piece}</b></span>`).join("")}</div>`;
}

// ====================================================================== VENTE

/** Un encaissement attend le client : on reste sur l'écran Vente. */
let salePaymentInProgress = false;

/** Panier de la vente en cours (garde son contenu si on change d'écran). */
const basket: SaleItem[] = [];

function basketTotal(): number {
  return basket.reduce((s, i) => s + i.priceCents * i.qty, 0);
}

function addToBasket(item: Product, qty = 1): void {
  const same = basket.find((i) => i.code && i.code === item.code && i.priceCents === item.priceCents);
  if (same) same.qty += qty;
  else basket.push({ ...item, qty });
}

/** Lignes de ticket pour les articles d'une vente. */
function itemTicketLines(items: SaleItem[]): TicketLine[] {
  return items.map((i) => ({ label: `${i.qty > 1 ? `${i.qty} × ` : ""}${i.name}`, value: money(i.priceCents * i.qty) }));
}

/** Code-barres inconnu : saisie du prix (et ajout au catalogue pour un administrateur). */
async function unknownProduct(code: string, presetCents?: number): Promise<Product | null> {
  const admin = S.user?.role === "admin";
  return modal<Product>(
    (body, close) => {
      body.innerHTML = `<form class="form" id="unk-form">
          <p class="dialog-text">Le code <b>${esc(code)}</b> n'est pas dans le catalogue.</p>
          <label>Nom de l'article<input name="name" maxlength="120" placeholder="ex. Coca-Cola 33 cl" ${admin ? "required" : ""}></label>
          <label>Prix (€)<input name="price" inputmode="decimal" required placeholder="ex. 1,20" value="${presetCents ? (presetCents / 100).toFixed(2).replace(".", ",") : ""}"></label>
          ${admin ? `<label class="check"><input type="checkbox" name="save" checked> Ajouter au catalogue (reconnu au prochain scan)</label>` : `<p class="muted small">Seul un administrateur peut ajouter l'article au catalogue.</p>`}
          <div class="dialog-actions"><button type="button" class="btn" data-no>Annuler</button><button class="btn btn-primary">Ajouter au panier</button></div>
        </form>`;
      const f = $<HTMLFormElement>("#unk-form", body);
      $("[data-no]", body).addEventListener("click", () => close(null));
      $<HTMLInputElement>(admin ? "[name=name]" : "[name=price]", body).focus();
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
        const cents = readEuros(v.price ?? "");
        if (Number.isNaN(cents) || cents <= 0) return toast("Prix invalide (ex. 1,20).", "error");
        const p: Product = { code, name: (v.name ?? "").trim() || "Article", priceCents: cents };
        if (admin && v.save) {
          const r = await window.api.call<OpResult>("products.save", p);
          if (!r.ok) return toast(r.message, "error");
        }
        close(p);
      });
    },
    { title: "Article inconnu" }
  );
}

function renderSale(root: HTMLElement): void {
  root.innerHTML = `<div class="sale">
    <section class="sale-entry">
      <div class="display">
        <span class="display-label" id="sale-label">Montant de la vente</span>
        <span class="display-amount" id="sale-amount">0,00 €</span>
        <span class="display-sub" id="sale-sub" hidden></span>
      </div>
      <button class="btn btn-lg btn-block sale-products" id="sale-products">${icon("grid")}<span>Articles</span></button>
      <div id="sale-pad"></div>
      <div class="sale-actions">
        <button class="btn btn-lg" id="sale-clear">Effacer</button>
        <button class="btn btn-lg" id="sale-add" title="Ajouter le montant tapé au panier">${icon("refill")}<span>Ajouter</span></button>
        <button class="btn btn-lg sale-card" id="sale-card" ${S.settings?.cardPayments === false ? "hidden" : ""}>${icon("card")}<span>Carte</span></button>
        <button class="btn btn-primary btn-xl" id="sale-go">Encaisser</button>
        <button class="btn btn-cancel btn-xl" id="sale-stop" hidden>${icon("cancel")}<span>Annuler l'encaissement</span></button>
      </div>
    </section>
    <section class="sale-live" id="sale-live"></section>
  </div>`;

  const amountEl = $("#sale-amount", root);
  const goBtn = $<HTMLButtonElement>("#sale-go", root);
  const addBtn = $<HTMLButtonElement>("#sale-add", root);
  let paying = false;
  let typedText = "";
  let typedCents = 0;
  const pad = keypad($("#sale-pad", root), {
    mode: "money",
    onChange: (text, cents) => {
      typedText = text;
      typedCents = cents;
      refreshDisplay();
    },
    onEnter: () => void start(),
  });

  /** Total à encaisser = panier + montant tapé au pavé (ajouté comme « Divers »). */
  function refreshDisplay(): void {
    const typed = typedCents;
    const total = basketTotal() + typed;
    const n = basket.reduce((s, i) => s + i.qty, 0);
    $("#sale-label", root).textContent = basket.length ? "Total du panier" : "Montant de la vente";
    if (basket.length) amountEl.textContent = money(total);
    else amountEl.innerHTML = amountDisplay(typedText);
    amountEl.classList.toggle("is-empty", total === 0);
    const sub = $("#sale-sub", root);
    sub.hidden = !basket.length;
    sub.textContent = `${n} article${n > 1 ? "s" : ""}${typed ? ` + ${money(typed)} tapé` : ""}`;
    goBtn.disabled = total === 0;
    addBtn.disabled = typed === 0;
  }

  pad.set("");
  $("#sale-clear", root).addEventListener("click", () => pad.set(""));
  addBtn.addEventListener("click", () => {
    const typed = pad.cents();
    if (!typed) return;
    basket.push({ code: "", name: "Divers", priceCents: typed, qty: 1 });
    pad.set("");
    idlePanel();
  });
  goBtn.addEventListener("click", () => void start());
  $("#sale-card", root).addEventListener("click", () => void startCard());
  $("#sale-products", root).addEventListener("click", () => {
    if (paying) return;
    void productPicker(
      (p) => {
        addToBasket({ code: p.code, name: p.name, priceCents: p.priceCents });
        idlePanel();
      },
      (code) => basket.filter((i) => i.code === code).reduce((s, i) => s + i.qty, 0)
    );
  });

  onScan((code) => void handleScan(code));
  idlePanel();

  async function handleScan(code: string): Promise<void> {
    if (paying) return void toast("Paiement en cours : terminez ou annulez d'abord.", "error");
    const r = await window.api.call<ScanLookup>("scan.lookup", code);
    if (r.kind === "invalid") return void toast(r.reason, "error");
    if (r.kind === "embedded-price") {
      addToBasket({ code: r.code, name: r.product?.name ?? "Article", priceCents: r.priceCents });
      toast(`${r.product?.name ?? "Article"} : ${money(r.priceCents)}`, "ok");
    } else if (r.product) {
      addToBasket(r.product);
    } else {
      const p = await unknownProduct(r.code);
      if (!p || !document.body.contains(root)) return;
      addToBasket(p);
    }
    idlePanel();
  }

  function basketPanel(live: HTMLElement): void {
    live.innerHTML = `<div class="panel basket">
      <div class="panel-head"><h2>Panier</h2><button class="btn btn-sm btn-danger" id="bk-clear">Vider</button></div>
      <div class="basket-lines">${basket
        .map(
          (i, idx) => `<div class="basket-line" data-i="${idx}">
            <div class="basket-name"><strong>${esc(i.name)}</strong><small>${!i.code ? "montant libre" : i.code.startsWith("ART-") ? "article" : esc(i.code)} · ${money(i.priceCents)}</small></div>
            <div class="pick-ctl"><button class="btn" data-d="-1" aria-label="Retirer un">−</button><b>${i.qty}</b><button class="btn" data-d="1" aria-label="Ajouter un">+</button></div>
            <strong class="basket-sum">${money(i.priceCents * i.qty)}</strong>
            <button class="icon-btn" data-del aria-label="Supprimer la ligne">✕</button>
          </div>`
        )
        .join("")}</div>
      <div class="basket-total"><span>Total</span><strong>${money(basketTotal())}</strong></div>
      <p class="muted small">Scannez d'autres articles, ou tapez un montant puis « Ajouter ».</p>
    </div>`;
    for (const line of $$<HTMLElement>(".basket-line", live)) {
      line.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (!b) return;
        const i = Number(line.dataset.i);
        if (b.hasAttribute("data-del")) basket.splice(i, 1);
        else {
          basket[i].qty += Number(b.dataset.d);
          if (basket[i].qty <= 0) basket.splice(i, 1);
        }
        idlePanel();
      });
    }
    $("#bk-clear", live).addEventListener("click", () => {
      basket.length = 0;
      idlePanel();
    });
  }

  function idlePanel(): void {
    refreshDisplay();
    const live = $("#sale-live", root);
    // Le panier reste visible même sans terminal (seul l'encaissement exige la connexion).
    if (basket.length) return basketPanel(live);
    if (S.cashier.connection !== "connected") {
      live.innerHTML = `<div class="panel panel-center">
        <div class="big-icon">${icon("plug")}</div>
        <h2>Terminal non connecté</h2>
        <p class="muted">Branchez le terminal pour encaisser.</p>
        <button class="btn btn-primary btn-lg" id="sale-connect">Connecter le terminal</button></div>`;
      $("#sale-connect", live).addEventListener("click", async (e) => {
        await connectTerminal(e.currentTarget as HTMLButtonElement);
        idlePanel();
      });
      return;
    }
    live.innerHTML = `<div class="panel">
      <div class="panel-head"><h2>Aujourd'hui</h2></div>
      <div class="day-kpis">
        <div class="day-kpi day-kpi-main"><span>Chiffre d'affaires</span><strong id="k-ca">…</strong></div>
        <div class="day-kpi"><span>Ventes</span><strong id="k-n">…</strong></div>
        <div class="day-kpi"><span>Panier moyen</span><strong id="k-avg">…</strong></div>
        <div class="day-kpi" id="k-change-box"><span>Monnaie pour rendre</span><strong id="k-change">…</strong></div>
      </div>
      <div class="panel-head"><h2>Dernières ventes</h2><span class="muted small">Scannez un article pour commencer un panier</span></div>
      <div id="recent" class="recent"></div>
    </div>`;
    const today = ymd(new Date());
    void window.api.call<PeriodStats>("stats.period", today, today).then((s) => {
      if (!document.body.contains(live) || !s || !document.getElementById("k-ca")) return;
      $("#k-ca", live).textContent = money(s.salesCents);
      $("#k-n", live).textContent = String(s.salesCount);
      $("#k-avg", live).textContent = money(s.averageSaleCents);
    });
    void window.api.call<OpResult & { inventory?: InventorySnapshot }>("fcc.inventory").then((r) => {
      if (!document.body.contains(live)) return;
      const box = document.getElementById("k-change-box");
      const val = document.getElementById("k-change");
      if (!box || !val) return;
      if (!r.ok || !r.inventory) return void (val.textContent = "-");
      const disp = r.inventory.dispensable;
      const coins = sumCents(disp.filter((l) => Number(l.fv) < 500));
      val.textContent = money(sumCents(disp));
      // Peu de pièces = risque de ne pas pouvoir rendre la monnaie.
      if (coins < 2000) {
        box.classList.add("day-kpi-warn");
        box.insertAdjacentHTML("beforeend", `<small>Peu de pièces (${money(coins)})</small>`);
      }
    });
    void window.api.call<TransactionRow[]>("history.list", today, today).then((rows) => {
      const el = document.getElementById("recent");
      if (!el || !Array.isArray(rows)) return;
      const sales = rows.filter((r) => r.kind === "sale" && r.ok).slice(0, 7);
      el.innerHTML = sales.length
        ? sales
            .map(
              (r) => `<div class="recent-row"><span class="recent-time">${new Date(r.ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })}</span>
              <span class="recent-user">${esc(r.user)}</span>
              <span class="recent-change">${r.outCents ? `rendu ${money(r.outCents)}` : ""}</span>
              <strong>${money(r.dueCents)}</strong></div>`
            )
            .join("")
        : `<p class="muted empty-line">Aucune vente pour l'instant.</p>`;
    });
  }

  /** Paiement par carte / sans contact (mode manuel : le caissier confirme). */
  async function startCard(): Promise<void> {
    if (paying) return;
    const typed = pad.cents();
    if (basket.length && typed) {
      basket.push({ code: "", name: "Divers", priceCents: typed, qty: 1 });
      pad.set("");
    }
    const items = basket.map((i) => ({ ...i }));
    const due = items.length ? basketTotal() : typed;
    if (due <= 0) return toast("Tapez un montant ou scannez un article.", "error");
    paying = true;
    salePaymentInProgress = true;
    const outcome = await modal<{ ok: boolean; ref: string }>(
      (body, close) => {
        body.innerHTML = `<div class="card-pay">
            <div class="card-pay-icon">${icon("card")}</div>
            <p class="card-pay-amount">${money(due)}</p>
            <ol class="card-pay-steps">
              <li>Tapez <b>${money(due)}</b> sur le terminal de paiement.</li>
              <li>Le client paie par carte ou sans contact (carte, téléphone, montre).</li>
              <li>Attendez « Approuvé » ou « Accepté » sur le terminal, puis confirmez ci-dessous.</li>
            </ol>
            <label class="card-pay-ref">Référence du ticket carte (facultatif)<input id="cp-ref" maxlength="40" autocomplete="off" placeholder="ex. n° d'autorisation"></label>
            <div class="dialog-actions">
              <button class="btn btn-lg btn-danger" data-no>Paiement refusé / annulé</button>
              <button class="btn btn-lg btn-primary" data-yes>${icon("card")}<span>Paiement accepté</span></button>
            </div>
          </div>`;
        $("[data-no]", body).addEventListener("click", () => close({ ok: false, ref: "" }));
        $("[data-yes]", body).addEventListener("click", () => close({ ok: true, ref: $<HTMLInputElement>("#cp-ref", body).value }));
      },
      { title: "Paiement par carte / sans contact" }
    );
    paying = false;
    salePaymentInProgress = false;
    if (!outcome?.ok) {
      toast("Paiement par carte annulé : le panier est conservé.", "info");
      return idlePanel();
    }
    const r = await window.api.call<MoneyResult>("sale.card", due, items, outcome.ref);
    if (!r.ok) return void toast(r.message, "error");
    pad.set("");
    basket.length = 0;
    refreshDisplay();
    const live = $("#sale-live", root);
    live.innerHTML = `<div class="panel pay pay-done">
        <div class="done-head"><span class="done-check">✓</span><div><h2>Payé par carte</h2><p class="muted">${money(due)}</p></div></div>
        <div class="change-hero no-change"><span>Pas de monnaie à rendre</span><strong>${money(0)}</strong></div>
        <div class="row-actions"><button class="btn btn-lg" id="pay-print">${icon("print")} Imprimer le ticket</button><button class="btn btn-primary btn-lg" id="pay-new">Nouvelle vente</button></div>
      </div>`;
    const ticketLines: TicketLine[] = [...itemTicketLines(items), { label: "TOTAL", value: money(due), strong: true }, { label: "Payé par carte", value: money(due) }];
    $("#pay-print", live).addEventListener("click", () => void printMoneyTicket("Vente", r, ticketLines));
    $("#pay-new", live).addEventListener("click", () => idlePanel());
    if (S.settings?.autoPrintReceipt) void printMoneyTicket("Vente", r, ticketLines);
  }

  async function start(): Promise<void> {
    const typed = pad.cents();
    if (basket.length && typed) {
      basket.push({ code: "", name: "Divers", priceCents: typed, qty: 1 });
      pad.set("");
    }
    const items = basket.map((i) => ({ ...i }));
    const due = items.length ? basketTotal() : typed;
    if (due <= 0) return toast("Tapez un montant ou scannez un article.", "error");
    if (S.cashier.connection !== "connected") return toast("Terminal non connecté.", "error");
    paying = true;
    salePaymentInProgress = true;
    goBtn.disabled = true;
    goBtn.hidden = true;
    addBtn.hidden = true;
    $<HTMLButtonElement>("#sale-card", root).hidden = true;
    $<HTMLButtonElement>("#sale-clear", root).hidden = true;
    const stopBtn = $<HTMLButtonElement>("#sale-stop", root);
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    $("#sale-pad", root).classList.add("is-locked");
    let received = 0;
    const inserted = new Map<string, DenomLine>();
    const live = $("#sale-live", root);
    live.innerHTML = `<div class="panel pay">
      <div class="pay-state"><span class="pulse"></span><span id="pay-status">Invitez le client à insérer billets et pièces</span></div>
      <div class="pay-grid">
        <div class="pay-fig"><span>À payer</span><strong>${money(due)}</strong></div>
        <div class="pay-fig pay-fig-in"><span>Reçu</span><strong id="pay-in">${money(0)}</strong></div>
        <div class="pay-fig pay-fig-rest"><span id="pay-rest-label">Reste à payer</span><strong id="pay-rest">${money(due)}</strong></div>
      </div>
      <div class="pay-progress"><span id="pay-bar"></span></div>
      <div id="pay-cash" class="pay-cash"></div>
      <button class="btn btn-cancel btn-xl btn-block" id="pay-cancel">${icon("cancel")}<span>Annuler l'encaissement</span></button>
      <p class="muted small pay-hint">L'annulation rend au client toutes les espèces déjà insérées.</p>
    </div>`;
    const update = () => {
      const rest = due - received;
      $("#pay-in", live).textContent = money(received);
      $("#pay-rest-label", live).textContent = rest > 0 ? "Reste à payer" : "À rendre";
      $("#pay-rest", live).textContent = money(Math.abs(rest));
      $(".pay-fig-rest", live).classList.toggle("is-change", rest < 0);
      $<HTMLElement>("#pay-bar", live).style.width = `${Math.min(100, (received / due) * 100)}%`;
    };
    onFcc((e) => {
      if (e.kind === "status") {
        if (e.amountCents > 0 || e.status === 3) received = e.amountCents;
        const st = document.getElementById("pay-status");
        if (st) st.textContent = e.status === 3 ? "Insérez billets et pièces" : e.label;
        update();
      }
      if (e.kind === "deposit") {
        for (const k of [...inserted.keys()]) if (inserted.get(k)!.devid === e.devid) inserted.delete(k);
        for (const l of e.lines) inserted.set(`${l.devid}|${l.fv}`, l);
        const box = document.getElementById("pay-cash");
        if (box) box.innerHTML = cashDetail([...inserted.values()]);
      }
    });
    const cancelBtns = [$<HTMLButtonElement>("#pay-cancel", live), stopBtn];
    const cancelPayment = async () => {
      for (const b of cancelBtns) {
        b.disabled = true;
        $("span", b).textContent = "Annulation…";
      }
      const r = await window.api.call("sale.cancel");
      if (!r.ok) {
        toast(r.message, "error");
        for (const b of cancelBtns) {
          b.disabled = false;
          $("span", b).textContent = "Annuler l'encaissement";
        }
      }
    };
    for (const b of cancelBtns) b.addEventListener("click", () => void cancelPayment());

    const r = await window.api.call<MoneyResult>("sale.start", due, items);
    paying = false;
    salePaymentInProgress = false;
    screenListeners = [];
    if (!document.body.contains(live)) return;
    stopBtn.hidden = true;
    goBtn.hidden = false;
    addBtn.hidden = false;
    $<HTMLButtonElement>("#sale-card", root).hidden = S.settings?.cardPayments === false;
    $("span", stopBtn).textContent = "Annuler l'encaissement";
    $<HTMLButtonElement>("#sale-clear", root).hidden = false;
    $("#sale-pad", root).classList.remove("is-locked");
    if (!document.body.contains(live)) return;
    if (r.ok) {
      pad.set("");
      basket.length = 0;
      refreshDisplay();
      live.innerHTML = `<div class="panel pay pay-done">
        <div class="done-head"><span class="done-check">✓</span><div><h2>Paiement accepté</h2><p class="muted">${money(due)} encaissés</p></div></div>
        <div class="change-hero ${r.outCents ? "" : "no-change"}"><span>${r.outCents ? "Monnaie rendue" : "Pas de monnaie à rendre"}</span><strong>${money(r.outCents)}</strong></div>
        <div class="pay-grid pay-grid-2">
          <div class="pay-fig"><span>Total</span><strong>${money(due)}</strong></div>
          <div class="pay-fig"><span>Reçu</span><strong>${money(r.inCents)}</strong></div>
        </div>
        <div class="cash-cols"><div><h3>Reçu</h3>${cashDetail(r.inLines)}</div>${r.outLines.length ? `<div><h3>Rendu</h3>${cashDetail(r.outLines)}</div>` : ""}</div>
        <div class="row-actions"><button class="btn btn-lg" id="pay-print">${icon("print")} Imprimer le ticket</button><button class="btn btn-primary btn-lg" id="pay-new">Nouvelle vente</button></div>
      </div>`;
      const ticketLines: TicketLine[] = [...itemTicketLines(items), { label: "TOTAL", value: money(due), strong: true }];
      $("#pay-print", live).addEventListener("click", () => void printMoneyTicket("Vente", r, ticketLines));
      $("#pay-new", live).addEventListener("click", () => idlePanel());
      if (S.settings?.autoPrintReceipt) void printMoneyTicket("Vente", r, ticketLines);
    } else {
      refreshDisplay();
      live.innerHTML = `<div class="panel pay pay-fail">
        <div class="done-head"><span class="done-check fail">!</span><div><h2>Vente non aboutie</h2><p>${esc(r.message)}</p></div></div>
        ${r.inLines?.length ? `<h3>Espèces rendues au client</h3>${cashDetail(r.inLines)}` : ""}
        ${basket.length ? `<p class="muted">Le panier est conservé : vous pouvez réessayer.</p>` : ""}
        <div class="row-actions"><button class="btn btn-primary btn-lg" id="pay-back">Retour</button></div></div>`;
      $("#pay-back", live).addEventListener("click", () => idlePanel());
    }
  }
}

// ==================================================================== ENCAISSE

const UNIT_STATUS: Record<number, { label: string; cls: string }> = {
  0: { label: "Vide", cls: "lvl-bad" },
  1: { label: "Presque vide", cls: "lvl-warn" },
  2: { label: "Normal", cls: "lvl-ok" },
  3: { label: "Presque plein", cls: "lvl-warn" },
  4: { label: "Plein", cls: "lvl-bad" },
  20: { label: "Restreint", cls: "lvl-warn" },
  21: { label: "Absent", cls: "lvl-bad" },
  22: { label: "Non disponible", cls: "lvl-off" },
};

let lastInventory: InventorySnapshot | null = null;

async function renderStock(root: HTMLElement): Promise<void> {
  if (!requireConnected(root)) return;
  root.innerHTML = `<div class="toolbar"><button class="btn btn-primary" id="inv-refresh">Actualiser</button><button class="btn" id="inv-print">Imprimer l'encaisse</button><span class="muted" id="inv-time"></span></div><div id="inv-body"><p class="muted">Chargement…</p></div>`;
  let loading = false;
  const load = async () => {
    if (loading) return;
    loading = true;
    try {
      const r = await window.api.call<OpResult & { inventory?: InventorySnapshot }>("fcc.inventory");
      if (!document.body.contains(root) || !document.getElementById("inv-body")) return;
      if (!r.ok || !r.inventory) {
        $("#inv-body", root).innerHTML = `<p class="error-text">${esc(r.message)}</p>`;
        return;
      }
      lastInventory = r.inventory;
      $("#inv-time", root).textContent = `Mis à jour à ${new Date().toLocaleTimeString(LOCALE)} (automatique)`;
      $("#inv-body", root).innerHTML = stockHtml(r.inventory);
    } finally {
      loading = false;
    }
  };
  // Mise à jour automatique : après chaque mouvement d'espèces signalé par le
  // terminal, et toutes les 20 s tant que l'écran est affiché.
  let pending = 0;
  onFcc((e) => {
    if (e.kind === "deposit" || e.kind === "unit" || (e.kind === "status" && (e.status === 1 || e.status === 0))) {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void load(), 1200);
    }
  });
  const timer = window.setInterval(() => {
    if (!document.body.contains(root) || S.screen !== "stock") return window.clearInterval(timer);
    void load();
  }, 20_000);
  $("#inv-refresh", root).addEventListener("click", (e) => void busy(e.currentTarget as HTMLButtonElement, load));
  $("#inv-print", root).addEventListener("click", async () => {
    if (!lastInventory) return;
    const s = S.receipt!;
    const v = inventoryViews(lastInventory);
    printTicket(
      ticketHtml(
        s,
        "Encaisse",
        null,
        [
          ...denomTicketLines(v.recycler),
          { label: "Dans les recycleurs", value: money(sumCents(v.recycler)), strong: true },
          ...(sumCents(v.collection) ? [{ label: "Dans le bac/cassette à vider", value: money(sumCents(v.collection)) }] : []),
          { label: "Total machine", value: money(sumCents(v.recycler) + sumCents(v.collection)) },
        ],
        { user: S.user?.name }
      ),
      s.paperFormat
    );
  });
  await load();
}

/**
 * Les deux contenus d'une machine Glory :
 * - recycleurs (stockeurs) : l'argent qui sert à rendre la monnaie ;
 * - bac / cassette de collecte : l'argent sorti par une collecte, qui attend
 *   d'être retiré. Le terminal le compte dans son « inventaire total » jusqu'à
 *   ce que la cassette soit vidée : c'est pourquoi l'ancien écran semblait
 *   « ne pas se vider » après une collecte.
 */
function inventoryViews(inv: InventorySnapshot): { recycler: DenomLine[]; collection: DenomLine[] } {
  const pick = (kinds: string[]) => aggregateLines(inv.units.filter((u) => kinds.includes(u.kind)).flatMap((u) => u.lines.map((l) => ({ ...l, devid: u.devid }))));
  const hasUnits = inv.units.some((u) => u.kind === "stacker" || u.kind === "mixed");
  return {
    recycler: hasUnits ? pick(["stacker", "mixed"]) : aggregateLines(inv.dispensable),
    collection: pick(["cassette"]),
  };
}

function stockHtml(inv: InventorySnapshot): string {
  const { recycler, collection } = inventoryViews(inv);
  const dispensable = aggregateLines(inv.dispensable);
  const recyclerCents = sumCents(recycler);
  const collectionCents = sumCents(collection);
  // Toutes les valeurs que la machine gère (une par stockeur), même à 0 :
  // un commerçant doit voir « 20 € : vide » pour savoir quoi recharger.
  const known = new Map<string, DenomLine>();
  for (const u of inv.units) if (u.kind === "stacker") for (const l of u.lines) if (Number(l.fv) > 0) known.set(`${u.devid}|${l.cc}|${l.fv}`, { ...l, devid: u.devid, piece: 0 });
  for (const l of recycler) known.set(`${l.devid}|${l.cc}|${l.fv}`, { ...l });
  const all = [...known.values()].sort((a, b) => Number(b.fv) - Number(a.fv));
  const isCoin = (l: DenomLine) => l.devid === "2" || Number(l.fv) < 500;
  const notes = all.filter((l) => !isCoin(l));
  const coins = all.filter(isCoin);
  const unitFor = (l: DenomLine) =>
    inv.units.find((u) => u.kind === "stacker" && u.devid === l.devid && u.lines.some((x) => x.fv === l.fv && x.cc === l.cc));
  const card = (l: DenomLine) => {
    const u = unitFor(l);
    const inUnit = u ? sumPieces(u.lines) : l.piece;
    const st = u ? (UNIT_STATUS[u.status] ?? { label: `État ${u.status}`, cls: "lvl-off" }) : { label: "", cls: "lvl-off" };
    const pct = u && u.max > 0 ? Math.min(100, Math.round((inUnit / u.max) * 100)) : 0;
    const disp = dispensable.find((d) => d.fv === l.fv && d.cc === l.cc && d.devid === l.devid)?.piece ?? l.piece;
    const inBox = collection.find((d) => d.fv === l.fv && d.cc === l.cc)?.piece ?? 0;
    return `<div class="denom-card ${l.piece === 0 ? "is-empty" : ""}">
      <div class="denom-visual">${cashHtml(l)}</div>
      <div class="denom-info">
        <div class="denom-count"><strong>${l.piece}</strong><span>${Number(l.fv) >= 500 ? "billets" : "pièces"}</span></div>
        <div class="denom-amount">${money(l.piece * Number(l.fv), l.cc)}</div>
        ${u ? `<div class="level"><span class="level-bar ${st.cls}" style="width:${pct}%"></span></div><div class="level-text"><span class="${st.cls}-text">${esc(l.piece === 0 ? "Vide" : st.label)}</span><span>${inUnit}/${u.max}</span></div>` : ""}
        ${disp !== l.piece ? `<div class="muted small">${disp} utilisable(s) pour rendre</div>` : ""}
        ${inBox ? `<div class="denom-box">+ ${inBox} dans le bac à vider</div>` : ""}
      </div></div>`;
  };
  return `<div class="kpis">
      <div class="kpi kpi-main"><span>Dans les recycleurs (pour rendre)</span><strong>${money(recyclerCents)}</strong></div>
      <div class="kpi ${collectionCents ? "kpi-warn" : ""}"><span>Dans le bac / cassette à vider</span><strong>${money(collectionCents)}</strong></div>
      <div class="kpi"><span>Total dans la machine</span><strong>${money(recyclerCents + collectionCents)}</strong></div>
      <div class="kpi"><span>Billets / pièces (recycleurs)</span><strong>${sumPieces(notes)} / ${sumPieces(coins)}</strong></div>
    </div>
    ${
      collectionCents
        ? `<div class="stock-note">${icon("collect")}<div><strong>${money(collectionCents)} ont été collectés et attendent d'être retirés.</strong><br>Ils ne servent plus à rendre la monnaie. Videz le bac ou la cassette (Gestion → Cassettes) : ce montant disparaîtra de l'écran une fois remis en place vide.</div></div>`
        : ""
    }
    <h2 class="section-title">Billets dans les recycleurs</h2>
    <div class="denom-grid">${notes.map(card).join("") || `<p class="muted">Aucun billet.</p>`}</div>
    <h2 class="section-title">Pièces dans les recycleurs</h2>
    <div class="denom-grid">${coins.map(card).join("") || `<p class="muted">Aucune pièce.</p>`}</div>
    ${
      inv.units.some((u) => u.kind === "cassette")
        ? `<h2 class="section-title">Bac et cassette de collecte</h2><div class="cassette-list">${inv.units
            .filter((u) => u.kind === "cassette")
            .map((u) => {
              const st = UNIT_STATUS[u.status] ?? { label: `État ${u.status}`, cls: "lvl-off" };
              return `<div class="cassette"><div><strong>${u.devid === "2" ? "Bac de collecte des pièces" : "Cassette de collecte des billets"}</strong> <span class="${st.cls}-text">${esc(sumPieces(u.lines) ? st.label : "Vide")}</span></div><div>${cashDetail(u.lines)}</div><div class="cassette-total">${money(sumCents(u.lines))}</div></div>`;
            })
            .join("")}</div>`
        : ""
    }`;
}

function sumPieces(lines: DenomLine[]): number {
  return lines.reduce((s, l) => s + l.piece, 0);
}

// ================================================================= OPÉRATIONS

interface HubTile {
  id: string;
  label: string;
  desc: string;
  icon: string;
  tone?: "danger";
  /** Ouvre un panneau dédié (avec bouton Retour). */
  render?: (el: HTMLElement) => void;
  /** Ou lance directement l'action (avec confirmation éventuelle). */
  action?: (btn: HTMLButtonElement) => Promise<void>;
}

/**
 * Grille de grandes tuiles, comme le menu du logiciel Glory de référence
 * du client : une tuile = une tâche, avec une phrase qui dit à quoi elle
 * sert. Une tuile ouvre un panneau ou lance directement l'action.
 */
function hub(root: HTMLElement, items: HubTile[]): void {
  const grid = () => {
    screenListeners = [];
    scanner.handler = null;
    root.innerHTML = `<div class="tiles">${items
      .map(
        (t) =>
          `<button class="tile ${t.tone === "danger" ? "tile-danger" : ""}" data-tile="${t.id}"><span class="tile-icon">${icon(t.icon)}</span><span class="tile-label">${esc(t.label)}</span><span class="tile-desc">${esc(t.desc)}</span></button>`
      )
      .join("")}</div>`;
    for (const b of $$<HTMLButtonElement>("[data-tile]", root)) {
      b.addEventListener("click", () => {
        const t = items.find((x) => x.id === b.dataset.tile)!;
        if (t.action) void busy(b, () => t.action!(b));
        else open(t);
      });
    }
  };
  const open = (t: HubTile) => {
    screenListeners = [];
    scanner.handler = null;
    root.innerHTML = `<div class="subhead"><button class="btn btn-back" id="hub-back">${icon("back")}<span>Retour</span></button><h2>${esc(t.label)}</h2></div><div class="subbody"></div>`;
    $("#hub-back", root).addEventListener("click", grid);
    t.render!($(".subbody", root));
  };
  grid();
}

/** Tuile d'action simple : confirmation éventuelle puis appel au terminal. */
function actionTile(id: string, label: string, desc: string, iconName: string, call: string, confirmText?: string, tone?: "danger"): HubTile {
  return {
    id,
    label,
    desc,
    icon: iconName,
    tone,
    action: async () => {
      if (S.cashier.connection !== "connected") return void toast("Terminal non connecté.", "error");
      if (confirmText && !(await confirmDialog(label, confirmText, "Confirmer", tone === "danger"))) return;
      report(await window.api.call(call));
    },
  };
}

/** Dépôt « en direct » : start → comptage → fin/annulation. */
function liveDeposit(el: HTMLElement, cfg: { title: string; intro: string; start: string; end: string; cancel: string; cancelLabel?: string; done: (r: MoneyResult) => void }): void {
  const cancelLabel = cfg.cancelLabel ?? "Annuler et rendre les espèces";
  el.innerHTML = `<div class="card narrow">
    <p>${esc(cfg.intro)}</p>
    <div class="display display-sm"><span class="display-label">Compté</span><span class="display-amount" id="dep-total">${money(0)}</span></div>
    <div id="dep-lines"></div>
    <div class="row-actions">
      <button class="btn btn-primary btn-lg" id="dep-start">Démarrer</button>
      <button class="btn btn-primary btn-lg" id="dep-end" hidden>Terminer et valider</button>
    </div>
    <button class="btn btn-cancel btn-xl btn-block dep-cancel" id="dep-cancel" hidden>${icon("cancel")}<span>${esc(cancelLabel)}</span></button>
    <p class="muted" id="dep-status"></p></div>`;
  const counted = new Map<string, DenomLine>();
  const render = () => {
    const lines = [...counted.values()];
    $("#dep-total", el).textContent = money(sumCents(lines));
    $("#dep-lines", el).innerHTML = cashDetail(lines);
  };
  const startBtn = $<HTMLButtonElement>("#dep-start", el);
  const endBtn = $<HTMLButtonElement>("#dep-end", el);
  const cancelBtn = $<HTMLButtonElement>("#dep-cancel", el);
  onFcc((e) => {
    if (e.kind === "deposit") {
      // eventDepositCountChange : cumul du dépôt en cours par module.
      for (const key of [...counted.keys()]) if (counted.get(key)!.devid === e.devid) counted.delete(key);
      for (const l of e.lines) counted.set(`${l.devid}|${l.fv}`, l);
      render();
    }
    if (e.kind === "status") $("#dep-status", el).textContent = e.label;
  });
  startBtn.addEventListener("click", () =>
    void busy(startBtn, async () => {
      const r = await window.api.call(cfg.start);
      if (!report(r, "Insérez les espèces.")) return;
      startBtn.hidden = true;
      endBtn.hidden = false;
      cancelBtn.hidden = false;
    })
  );
  endBtn.addEventListener("click", () =>
    void busy(endBtn, async () => {
      const r = await window.api.call<MoneyResult>(cfg.end);
      if (!report(r)) return;
      cfg.done(r);
    })
  );
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    $("span", cancelBtn).textContent = "Annulation…";
    const r = await window.api.call(cfg.cancel);
    if (report(r, "Annulé, espèces restituées.")) return liveDeposit(el, cfg);
    cancelBtn.disabled = false;
    $("span", cancelBtn).textContent = cancelLabel;
  });
}

function renderOps(root: HTMLElement): void {
  if (!requireConnected(root)) return;
  const items: HubTile[] = [
    {
      id: "deposit",
      label: "Dépôt",
      desc: "Ajouter des espèces sans vente (apport, fond de caisse).",
      icon: "deposit",
      render: (el: HTMLElement) =>
        liveDeposit(el, {
          title: "Dépôt",
          intro: "Dépôt d'espèces sans vente (fond de caisse, apport...). Les espèces restent dans la machine.",
          start: "deposit.start",
          end: "deposit.end",
          cancel: "deposit.cancel",
          cancelLabel: "Annuler le dépôt et rendre les espèces",
          done: (r) => {
            el.innerHTML = `<div class="card narrow"><div class="done-badge">✓ Dépôt enregistré : ${money(r.inCents)}</div>${cashDetail(r.inLines)}
              <div class="row-actions"><button class="btn btn-lg" id="d-print">Imprimer</button><button class="btn btn-primary btn-lg" id="d-again">Nouveau dépôt</button></div></div>`;
            $("#d-print", el).addEventListener("click", () => void printMoneyTicket("Dépôt", r, denomTicketLines(r.inLines)));
            $("#d-again", el).addEventListener("click", () => renderOps(root));
          },
        }),
    },
    { id: "exchange", label: "Échange de monnaie", desc: "Le client dépose, vous choisissez les billets et pièces à lui rendre.", icon: "exchange", render: renderExchange },
    ...(S.user?.role === "admin"
      ? [{ id: "payout", label: "Sortie d'espèces", desc: "Remboursement, paiement fournisseur, retrait de caisse.", icon: "payout", render: renderPayout }]
      : []),
    actionTile(
      "deposit-cancel",
      "Annuler un dépôt",
      "Annule le dépôt ou l'encaissement en cours et rend au client les espèces déjà insérées.",
      "cancel",
      "deposit.cancel",
      "Annuler le dépôt en cours ? Les espèces déjà insérées seront rendues.",
      "danger"
    ),
    actionTile("coins", "Rendre les pièces", "Rend les pièces restées dans l'entrée (client qui change d'avis).", "coins", "coins.return"),
  ];
  hub(root, items);
}

function renderExchange(el: HTMLElement): void {
  liveDeposit(el, {
    title: "Échange",
    intro: "1. Le client dépose ses espèces.  2. Choisissez les billets/pièces à lui rendre pour le même montant.",
    start: "exchange.start",
    end: "exchange.received",
    cancel: "deposit.cancel",
    done: (received) => void chooseGive(received),
  });

  async function chooseGive(received: MoneyResult): Promise<void> {
    const inv = await window.api.call<OpResult & { inventory?: InventorySnapshot }>("fcc.inventory");
    const avail = inv.inventory ? aggregateLines(inv.inventory.dispensable).filter((l) => l.piece > 0) : [];
    const give = new Map<string, number>();
    el.innerHTML = `<div class="card">
      <div class="kpis"><div class="kpi"><span>Déposé</span><strong>${money(received.inCents)}</strong></div>
      <div class="kpi"><span>Sélectionné</span><strong id="ex-sel">${money(0)}</strong></div>
      <div class="kpi"><span>Reste</span><strong id="ex-rest">${money(received.inCents)}</strong></div></div>
      <div class="pick-grid">${avail
        .map((l) => `<div class="pick" data-fv="${esc(l.fv)}">${cashHtml(l)}<div class="pick-ctl"><button class="btn" data-d="-1">−</button><b data-n>0</b><button class="btn" data-d="1">+</button></div><small>${l.piece} dispo</small></div>`)
        .join("")}</div>
      <div class="row-actions"><button class="btn btn-danger btn-lg" id="ex-refund">Rendre le dépôt tel quel</button><button class="btn btn-primary btn-lg" id="ex-ok" disabled>Rendre la sélection</button></div></div>`;
    const lines = () => avail.map((l) => ({ ...l, piece: give.get(l.fv) ?? 0 })).filter((l) => l.piece > 0);
    const refresh = () => {
      const sel = sumCents(lines());
      $("#ex-sel", el).textContent = money(sel);
      $("#ex-rest", el).textContent = money(received.inCents - sel);
      $<HTMLButtonElement>("#ex-ok", el).disabled = sel !== received.inCents;
    };
    for (const p of $$(".pick", el)) {
      p.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button[data-d]") as HTMLButtonElement | null;
        if (!b) return;
        const fv = p.dataset.fv!;
        const max = avail.find((l) => l.fv === fv)!.piece;
        const n = Math.max(0, Math.min(max, (give.get(fv) ?? 0) + Number(b.dataset.d)));
        give.set(fv, n);
        $("[data-n]", p).textContent = String(n);
        refresh();
      });
    }
    $("#ex-ok", el).addEventListener("click", (e) =>
      void busy(e.currentTarget as HTMLButtonElement, async () => {
        const r = await window.api.call<MoneyResult>("exchange.give", received.inCents, received.inLines, lines());
        if (!report(r, "Échange effectué.")) return;
        el.innerHTML = `<div class="card narrow"><div class="done-badge">✓ Échange effectué</div><h3>Reçu</h3>${cashDetail(r.inLines)}<h3>Rendu</h3>${cashDetail(r.outLines)}
          <div class="row-actions"><button class="btn btn-lg" id="ex-print">Imprimer</button></div></div>`;
        $("#ex-print", el).addEventListener("click", () => void printMoneyTicket("Échange", r));
      })
    );
    $("#ex-refund", el).addEventListener("click", (e) =>
      void busy(e.currentTarget as HTMLButtonElement, async () => {
        const r = await window.api.call<MoneyResult>("exchange.give", received.inCents, received.inLines, received.inLines);
        report(r, "Dépôt rendu au client.");
        if (r.ok) renderExchange(el);
      })
    );
  }
}

function renderPayout(el: HTMLElement): void {
  el.innerHTML = `<div class="split">
    <div class="card"><div class="display display-sm"><span class="display-label">Montant à sortir</span><span class="display-amount" id="po-amount">0,00 €</span></div><div id="po-pad"></div></div>
    <div class="card"><div class="card-head"><h2>Motif</h2></div>
      <div class="choice" id="po-reason">${["Remboursement client", "Paiement fournisseur", "Retrait de caisse", "Autre"].map((r, i) => `<button class="btn ${i === 0 ? "active" : ""}" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <p class="muted">La machine choisit automatiquement les billets et pièces parmi le stock distribuable.</p>
      <button class="btn btn-primary btn-xl" id="po-go">Sortir les espèces</button></div></div>`;
  const amount = $("#po-amount", el);
  const pad = keypad($("#po-pad", el), { mode: "money", onChange: (text) => (amount.innerHTML = amountDisplay(text)) });
  let reason = "Remboursement client";
  for (const b of $$<HTMLButtonElement>("#po-reason button", el))
    b.addEventListener("click", () => {
      reason = b.dataset.r!;
      for (const x of $$("#po-reason button", el)) x.classList.toggle("active", x === b);
    });
  $("#po-go", el).addEventListener("click", async (e) => {
    const cents = pad.cents();
    if (cents <= 0) return toast("Saisissez un montant.", "error");
    if (!(await confirmDialog("Sortie d'espèces", `Sortir ${money(cents)} (${reason}) ?`, "Sortir"))) return;
    await busy(e.currentTarget as HTMLButtonElement, async () => {
      const r = await window.api.call<MoneyResult>("payout", cents, reason);
      if (!report(r, `${money(cents)} sortis.`)) return;
      pad.set("");
      void printMoneyTicket(reason, r, denomTicketLines(r.outLines));
    });
  });
}

// =================================================================== GESTION

function renderManage(root: HTMLElement): void {
  if (!requireConnected(root)) return;
  hub(root, [
    {
      id: "refill",
      label: "Réapprovisionner",
      desc: "Remettre de la monnaie dans la machine pour pouvoir rendre.",
      icon: "refill",
      render: (el) =>
        liveDeposit(el, {
          title: "Réapprovisionnement",
          intro: "Ajoutez de la monnaie dans les recycleurs (fond de caisse, monnaie pour le rendu).",
          start: "refill.start",
          end: "refill.end",
          cancel: "refill.cancel",
          done: (r) => {
            el.innerHTML = `<div class="card narrow"><div class="done-badge">✓ Réapprovisionné : ${money(r.inCents)}</div>${cashDetail(r.inLines)}
              <div class="row-actions"><button class="btn btn-lg" id="rf-print">Imprimer</button></div></div>`;
            $("#rf-print", el).addEventListener("click", () => void printMoneyTicket("Réapprovisionnement", r, denomTicketLines(r.inLines)));
          },
        }),
    },
    { id: "products", label: "Articles", desc: "Catalogue : codes-barres, noms et prix des articles scannés.", icon: "doc", render: renderProducts },
    { id: "collect", label: "Collecter", desc: "Sortir un montant exact, le surplus ou tout, en billets et/ou pièces.", icon: "collect", render: renderCollect },
    {
      id: "cassettes",
      label: "Cassettes",
      desc: "Déverrouiller pour vider la cassette, puis reverrouiller.",
      icon: "lock",
      render: (el) => {
        el.innerHTML = `<div class="grid-2">
          ${[1, 2]
            .map(
              (u) => `<div class="card"><div class="card-head"><h2>Cassette ${u === 1 ? "billets" : "pièces"}</h2></div>
            <p class="muted">Déverrouillez pour retirer la cassette après une collecte.</p>
            <div class="row-actions"><button class="btn btn-primary btn-lg" data-unlock="${u}">Déverrouiller</button><button class="btn btn-lg" data-lock="${u}">Verrouiller</button></div></div>`
            )
            .join("")}</div>`;
        for (const b of $$<HTMLButtonElement>("[data-unlock]", el)) b.addEventListener("click", () => void busy(b, async () => report(await window.api.call("unit.unlock", Number(b.dataset.unlock)))));
        for (const b of $$<HTMLButtonElement>("[data-lock]", el)) b.addEventListener("click", () => void busy(b, async () => report(await window.api.call("unit.lock", Number(b.dataset.lock)))));
      },
    },
    {
      id: "cover",
      label: "Ouverture du cache",
      desc: "Ouvrir / fermer le cache de sortie pour récupérer des billets refusés.",
      icon: "door",
      render: (el) => {
        el.innerHTML = `<div class="card narrow"><p>Ouvrez le cache, retirez les billets, puis refermez-le.</p>
          <div class="row-actions"><button class="btn btn-primary btn-lg" data-a="cover.open">Ouvrir le cache</button><button class="btn btn-lg" data-a="cover.close">Fermer le cache</button></div></div>`;
        for (const b of $$<HTMLButtonElement>("[data-a]", el)) b.addEventListener("click", () => void busy(b, async () => report(await window.api.call(b.dataset.a!))));
      },
    },
  ]);
}

/** Montant tapé en euros (« 12,50 », « 12.5 », « 40 ») → centimes ; NaN si illisible. */
function readEuros(text: string): number {
  const t = text.replace(/[\s€]/g, "").replace(".", ",");
  if (!/^\d+(,\d{0,2})?$/.test(t)) return NaN;
  return parseAmount(t);
}

function renderCollect(el: HTMLElement): void {
  const floatDefault = S.settings?.defaultFloatCents ?? 20000;
  type Mode = "exact" | "float" | "all" | "manual";
  type Kind = "all" | "notes" | "coins";
  let mode: Mode = "exact";
  let kind: Kind = "all";
  el.innerHTML = `<div class="card">
    <p>Transfère des espèces des recycleurs vers la cassette de collecte (à vider ensuite).</p>
    <h3>Quoi collecter</h3>
    <div class="choice" id="col-kind">
      <button class="btn active" data-k="all">Billets et pièces</button>
      <button class="btn" data-k="notes">Billets seulement</button>
      <button class="btn" data-k="coins">Pièces seulement</button>
    </div>
    <h3>Comment</h3>
    <div class="choice" id="col-mode">
      <button class="btn active" data-m="exact">Montant exact</button>
      <button class="btn" data-m="float">Laisser un fond de caisse</button>
      <button class="btn" data-m="all">Tout collecter</button>
      <button class="btn" data-m="manual">Choisir à la main</button>
    </div>
    <p class="col-float-info" id="col-float-info" hidden></p>
    <div class="col-amount" id="col-amount">
      <label class="field" id="col-amount-field"><span id="col-amount-label">Montant à collecter (€)</span><input id="col-amount-v" inputmode="decimal" autocomplete="off" placeholder="ex. 150,00"></label>
      <button class="btn btn-primary btn-lg" id="col-plan">Préparer la collecte</button>
    </div>
    <div id="col-preview"></div></div>`;

  const amountInput = $<HTMLInputElement>("#col-amount-v", el);
  const planBtn = $<HTMLButtonElement>("#col-plan", el);
  const isCoin = (l: DenomLine) => l.devid === "2" || Number(l.fv) < 500;
  const availableFor = (inv: OpResult & { inventory?: InventorySnapshot }) =>
    (inv.inventory?.dispensable ?? []).filter((l) => l.piece > 0 && (kind === "all" || (kind === "coins") === isCoin(l)));
  // Inventaire affiché dès l'ouverture (rien de sélectionné) ; « Préparer » remplit ensuite la sélection.
  let invSeq = 0;
  const showInventory = async () => {
    const seq = ++invSeq;
    const inv = await window.api.call<OpResult & { inventory?: InventorySnapshot }>("fcc.inventory");
    if (seq !== invSeq || !el.isConnected) return;
    if (!inv.ok) return void ($("#col-preview", el).innerHTML = `<p class="error-text">${esc(inv.message)}</p>`);
    preview(availableFor(inv), [], 0);
  };
  const syncForm = () => {
    $("#col-amount-label", el).textContent = mode === "float" ? "Fond de caisse à laisser (€)" : "Montant à collecter (€)";
    const comp = S.settings?.floatComposition ?? {};
    const useComp = mode === "float" && Object.keys(comp).length > 0;
    $("#col-amount-field", el).hidden = mode === "all" || mode === "manual" || useComp;
    const info = $("#col-float-info", el);
    info.hidden = !useComp;
    if (useComp) info.innerHTML = `La machine gardera le fond de caisse réglé : <b>${esc(compositionSummary(comp))}</b> = <b>${money(compositionTotal(comp))}</b>. <span class="muted">(Réglages → Fond de caisse)</span>`;
    if (mode === "float") amountInput.value = String(floatDefault / 100).replace(".", ",");
    if (mode === "exact") amountInput.value = "";
    void showInventory();
    if (mode === "exact") amountInput.focus();
  };
  for (const b of $$<HTMLButtonElement>("#col-mode button", el))
    b.addEventListener("click", () => {
      mode = b.dataset.m as Mode;
      for (const x of $$("#col-mode button", el)) x.classList.toggle("active", x === b);
      syncForm();
    });
  for (const b of $$<HTMLButtonElement>("#col-kind button", el))
    b.addEventListener("click", () => {
      kind = b.dataset.k as Kind;
      for (const x of $$("#col-kind button", el)) x.classList.toggle("active", x === b);
      void showInventory();
    });
  syncForm();
  amountInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") planBtn.click();
  });

  planBtn.addEventListener("click", () =>
    void busy(planBtn, async () => {
      let cents = 0;
      if (mode === "exact" || mode === "float") {
        cents = readEuros(amountInput.value);
        if (Number.isNaN(cents) || (mode === "exact" && cents <= 0)) return void toast("Tapez un montant, par exemple 150 ou 152,50.", "error");
      }
      const r = await window.api.call<OpResult & { plan?: DenomLine[] }>("collect.plan", mode === "manual" ? "all" : mode, cents, kind);
      if (!r.ok || !r.plan) return void toast(r.message, "error");
      const seq = ++invSeq;
      const inv = await window.api.call<OpResult & { inventory?: InventorySnapshot }>("fcc.inventory");
      if (seq !== invSeq) return;
      preview(availableFor(inv), mode === "manual" ? [] : r.plan, mode === "exact" ? cents : 0);
    })
  );

  function preview(avail: DenomLine[], plan: DenomLine[], target: number): void {
    const box = $("#col-preview", el);
    if (avail.length === 0) return void (box.innerHTML = `<p class="muted empty-line">Rien de disponible à collecter pour ce choix.</p>`);
    const key = (l: DenomLine) => `${l.devid}|${l.fv}`;
    const lines = [...avail].sort((a, b) => Number(b.fv) - Number(a.fv));
    const take = new Map<string, number>(lines.map((l) => [key(l), plan.find((p) => p.fv === l.fv && p.devid === l.devid)?.piece ?? 0]));
    box.innerHTML = `<div class="col-figs">
        ${target ? `<div class="pay-fig"><span>Montant demandé</span><strong>${money(target)}</strong></div>` : ""}
        <div class="pay-fig pay-fig-in"><span>Sélectionné</span><strong id="col-total"></strong></div>
        ${target ? `<div class="pay-fig" id="col-gap-box"><span>Écart</span><strong id="col-gap"></strong></div>` : ""}
      </div>
      <p class="muted small">Ajustez avec − / + si besoin. « Max » prend tout ce qu'il y a dans la machine pour cette valeur.</p>
      <div class="pick-grid">${lines
        .map(
          (l) => `<div class="pick" data-key="${esc(key(l))}">${cashHtml(l)}
            <div class="pick-ctl"><button class="btn" data-d="-1">−</button><b data-n></b><button class="btn" data-d="1">+</button></div>
            <small><span data-amt></span> · ${l.piece} en machine</small>
            <button class="btn btn-sm" data-max>Max</button></div>`
        )
        .join("")}</div>
      <div class="row-actions"><button class="btn btn-primary btn-lg" id="col-run">Lancer la collecte</button></div>`;
    const selected = (): DenomLine[] => lines.map((l) => ({ ...l, piece: take.get(key(l)) ?? 0 })).filter((l) => l.piece > 0);
    const refresh = () => {
      for (const p of $$<HTMLElement>(".pick", box)) {
        const l = lines.find((x) => key(x) === p.dataset.key)!;
        const n = take.get(key(l)) ?? 0;
        $("[data-n]", p).textContent = String(n);
        $("[data-amt]", p).textContent = money(n * Number(l.fv));
        p.classList.toggle("is-on", n > 0);
      }
      const sel = sumCents(selected());
      $("#col-total", box).textContent = money(sel);
      $<HTMLButtonElement>("#col-run", box).disabled = sel === 0 || (target > 0 && sel !== target);
      if (target) {
        const gap = sel - target;
        $("#col-gap", box).textContent = gap === 0 ? "Exact ✓" : `${gap > 0 ? "+" : "−"} ${money(Math.abs(gap))}`;
        $("#col-gap-box", box).classList.toggle("is-exact", gap === 0);
        $("#col-gap-box", box).classList.toggle("is-off", gap !== 0);
      }
    };
    for (const p of $$<HTMLElement>(".pick", box)) {
      p.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
        if (!btn) return;
        const l = lines.find((x) => key(x) === p.dataset.key)!;
        const cur = take.get(key(l)) ?? 0;
        const n = btn.hasAttribute("data-max") ? l.piece : Math.max(0, Math.min(l.piece, cur + Number(btn.dataset.d)));
        take.set(key(l), n);
        refresh();
      });
    }
    refresh();
    $("#col-run", box).addEventListener("click", async (e) => {
      const sel = selected();
      if (sel.length === 0) return toast("Rien à collecter.", "error");
      if (!(await confirmDialog("Collecte", `Collecter ${money(sumCents(sel))} vers la cassette ?`, "Collecter"))) return;
      await busy(e.currentTarget as HTMLButtonElement, async () => {
        const r = await window.api.call<MoneyResult>("collect.run", sel);
        if (!report(r, `Collecte effectuée : ${money(r.outCents)}.`)) return;
        box.innerHTML = `<div class="done-badge">✓ Collecte effectuée : ${money(r.outCents)}</div>${cashDetail(r.outLines)}<div class="row-actions"><button class="btn btn-lg" id="col-print">Imprimer le bordereau</button></div>`;
        $("#col-print", box).addEventListener("click", () => void printMoneyTicket("Collecte", r, denomTicketLines(r.outLines)));
      });
    });
  }
}

// ================================================================ HISTORIQUE

const KIND_LABEL: Record<string, string> = {
  sale: "Vente",
  deposit: "Dépôt",
  payout: "Sortie",
  refill: "Réappro.",
  collect: "Collecte",
  exchange: "Échange",
  cancel: "Annulation",
};

function renderHistory(root: HTMLElement): void {
  const today = ymd(new Date());
  root.innerHTML = `<div class="toolbar card toolbar-card">
      <label>Du <input type="date" id="h-from" value="${today}"></label>
      <label>au <input type="date" id="h-to" value="${today}"></label>
      <select id="h-kind"><option value="">Toutes les opérations</option>${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <button class="btn btn-primary" id="h-go">Afficher</button>
      ${S.user?.role === "admin" ? `<button class="btn" id="h-csv">Exporter (Excel)</button>` : ""}
    </div><div id="h-body"></div>`;
  const load = async () => {
    const from = $<HTMLInputElement>("#h-from", root).value;
    const to = $<HTMLInputElement>("#h-to", root).value;
    const kind = $<HTMLSelectElement>("#h-kind", root).value;
    let rows = await window.api.call<TransactionRow[]>("history.list", from, to);
    if (!Array.isArray(rows)) return void toast("Historique indisponible.", "error");
    if (kind) rows = rows.filter((r) => r.kind === kind);
    const okRows = rows.filter((r) => r.ok && r.kind !== "cancel");
    const salesCents = okRows.filter((r) => r.kind === "sale").reduce((s, r) => s + (r.dueCents ?? 0), 0);
    const inCents = okRows.reduce((s, r) => s + r.inCents, 0);
    const outCents = okRows.reduce((s, r) => s + r.outCents, 0);
    // Regroupement par jour (le plus récent d'abord, comme la liste).
    const days = new Map<string, TransactionRow[]>();
    for (const r of rows) {
      const d = new Date(r.ts).toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      if (!days.has(d)) days.set(d, []);
      days.get(d)!.push(r);
    }
    const status = (r: TransactionRow) =>
      r.kind === "cancel" ? `<span class="pill pill-muted">Annulée</span>` : r.ok ? `<span class="pill pill-ok">Réussie</span>` : `<span class="pill pill-bad">Échec</span>`;
    const mainAmount = (r: TransactionRow) => {
      if (r.kind === "cancel") return r.dueCents !== null ? money(r.dueCents) : money(r.inCents);
      if (r.dueCents !== null) return money(r.dueCents);
      if (r.kind === "payout" || r.kind === "collect") return `− ${money(r.outCents)}`;
      return money(r.inCents || r.outCents);
    };
    const detail = (r: TransactionRow) => {
      const parts: string[] = [];
      if (r.kind === "sale" && r.method === "card") parts.push("payé par carte");
      if (r.inCents) parts.push(`reçu ${money(r.inCents)}`);
      if (r.outCents) parts.push(`${r.kind === "sale" || r.kind === "cancel" ? "rendu" : "sorti"} ${money(r.outCents)}`);
      return parts.join(" · ");
    };
    // Les notes techniques (« Vente : OK ») n'apprennent rien à l'utilisateur.
    const note = (r: TransactionRow) => (r.kind === "cancel" || /:\s*OK$/i.test(r.note) ? "" : r.note);
    const title = (r: TransactionRow) => (r.kind === "cancel" ? (/dépôt/i.test(r.note) ? "Dépôt annulé" : "Vente annulée") : KIND_LABEL[r.kind] ?? r.kind);
    const sub = (r: TransactionRow) => [esc(r.user), r.ticketNo ? `ticket n° ${r.ticketNo}` : "", note(r) ? esc(note(r)) : ""].filter(Boolean).join(" · ");
    $("#h-body", root).innerHTML = rows.length
      ? `<div class="hist-kpis">
          <div class="pay-fig pay-fig-in"><span>Ventes</span><strong>${money(salesCents)}</strong></div>
          <div class="pay-fig"><span>Espèces reçues</span><strong>${money(inCents)}</strong></div>
          <div class="pay-fig"><span>Rendu / sorti</span><strong>${money(outCents)}</strong></div>
          <div class="pay-fig"><span>Opérations</span><strong>${rows.length}</strong></div>
        </div>
        ${[...days]
          .map(
            ([day, list]) => `<section class="card hist-day">
              <div class="hist-day-head"><h2>${esc(day.charAt(0).toUpperCase() + day.slice(1))}</h2><span class="muted">${list.length} opération(s)</span></div>
              ${list
                .map(
                  (r) => `<button class="hist-row ${r.ok || r.kind === "cancel" ? "" : "is-failed"}" data-id="${r.id}">
                    <span class="hist-time">${new Date(r.ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })}</span>
                    <span class="hist-icon hist-${r.kind}${r.method === "card" ? " hist-card" : ""}">${icon(r.kind === "cancel" ? "cancel" : r.method === "card" ? "card" : r.kind)}</span>
                    <span class="hist-main"><strong>${title(r)}</strong><small>${sub(r)}</small></span>
                    <span class="hist-amount"><strong>${mainAmount(r)}</strong><small>${detail(r)}</small></span>
                    <span class="hist-status">${status(r)}</span>
                  </button>`
                )
                .join("")}
            </section>`
          )
          .join("")}`
      : `<div class="card empty"><p>Aucune opération sur cette période.</p></div>`;
    for (const tr of $$<HTMLButtonElement>(".hist-row[data-id]", root))
      tr.addEventListener("click", () => {
        const r = rows.find((x) => x.id === Number(tr.dataset.id))!;
        void modal(
          (body) => {
            body.innerHTML = `<div class="detail">
              <div class="pay-row"><span>Date</span><strong>${fmtDateTime(r.ts)}</strong></div>
              <div class="pay-row"><span>Utilisateur</span><strong>${esc(r.user)}</strong></div>
              ${r.dueCents !== null ? `<div class="pay-row"><span>Montant</span><strong>${money(r.dueCents)}</strong></div>` : ""}
              <div class="pay-row"><span>Reçu</span><strong>${money(r.inCents)}</strong></div>
              <div class="pay-row"><span>Rendu / sorti</span><strong>${money(r.outCents)}</strong></div>
              ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ""}
              ${r.items?.length ? `<h3>Articles</h3><table class="table"><tbody>${r.items.map((i) => `<tr><td>${i.qty} × ${esc(i.name)}</td><td class="num">${money(i.qty * i.priceCents)}</td></tr>`).join("")}</tbody></table>` : ""}
              ${r.inLines.length ? `<h3>Reçu</h3>${cashDetail(r.inLines)}` : ""}${r.outLines.length ? `<h3>Rendu / sorti</h3>${cashDetail(r.outLines)}` : ""}
              ${r.ok ? `<button class="btn btn-lg" id="h-reprint">Réimprimer le ticket</button>` : ""}</div>`;
            document.getElementById("h-reprint")?.addEventListener("click", () => {
              const s = S.receipt!;
              const lines: TicketLine[] = [];
              if (r.items?.length) lines.push(...itemTicketLines(r.items));
              if (r.dueCents !== null) lines.push({ label: "TOTAL", value: money(r.dueCents), strong: true });
              if (r.method === "card" && r.dueCents !== null) lines.push({ label: "Payé par carte", value: money(r.dueCents) });
              if (r.inCents) lines.push({ label: "Espèces reçues", value: money(r.inCents) });
              if (r.outCents) lines.push({ label: r.kind === "sale" ? "Rendu" : "Sorti", value: money(r.outCents) });
              lines.push({ label: "Duplicata", value: "" });
              printTicket(ticketHtml(s, KIND_LABEL[r.kind] ?? r.kind, r.ticketNo, lines, { barcodeCents: r.dueCents ?? r.inCents, user: r.user }), s.paperFormat);
            });
          },
          { title: `${KIND_LABEL[r.kind] ?? r.kind} n° ${r.id}` }
        );
      });
  };
  $("#h-go", root).addEventListener("click", () => void load());
  document.getElementById("h-csv")?.addEventListener("click", async () => {
    report(await window.api.call("history.exportCsv", $<HTMLInputElement>("#h-from", root).value, $<HTMLInputElement>("#h-to", root).value));
  });
  void load();
}

// ============================================================== STATISTIQUES

function renderStats(root: HTMLElement): void {
  const d = new Date();
  const presets: Record<string, [Date, Date]> = {
    today: [d, d],
    yesterday: [new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1), new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)],
    week: [new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6), d],
    month: [new Date(d.getFullYear(), d.getMonth(), 1), d],
  };
  root.innerHTML = `<div class="toolbar">
      <div class="choice" id="st-preset">
        <button class="btn active" data-p="today">Aujourd'hui</button><button class="btn" data-p="yesterday">Hier</button>
        <button class="btn" data-p="week">7 jours</button><button class="btn" data-p="month">Ce mois</button></div>
      <label>Du <input type="date" id="st-from"></label><label>au <input type="date" id="st-to"></label>
      <button class="btn" id="st-go">Afficher</button>
      ${S.user?.role === "admin" ? `<button class="btn btn-primary" id="st-close">Clôture de caisse</button>` : ""}
    </div><div id="st-body"></div>`;
  const setRange = (p: string) => {
    const [a, b] = presets[p];
    $<HTMLInputElement>("#st-from", root).value = ymd(a);
    $<HTMLInputElement>("#st-to", root).value = ymd(b);
  };
  const load = async () => {
    const s = await window.api.call<PeriodStats>("stats.period", $<HTMLInputElement>("#st-from", root).value, $<HTMLInputElement>("#st-to", root).value);
    $("#st-body", root).innerHTML = statsHtml(s);
  };
  for (const b of $$<HTMLButtonElement>("#st-preset button", root))
    b.addEventListener("click", () => {
      for (const x of $$("#st-preset button", root)) x.classList.toggle("active", x === b);
      setRange(b.dataset.p!);
      void load();
    });
  $("#st-go", root).addEventListener("click", () => {
    for (const x of $$("#st-preset button", root)) x.classList.remove("active");
    void load();
  });
  document.getElementById("st-close")?.addEventListener("click", (e) => void closing(e.currentTarget as HTMLButtonElement));
  setRange("today");
  void load();
}

function statsHtml(s: PeriodStats): string {
  const maxHour = Math.max(1, ...s.byHour.map((h) => h.salesCents));
  return `<div class="kpis">
      <div class="kpi kpi-main"><span>Chiffre d'affaires</span><strong>${money(s.salesCents)}</strong></div>
      <div class="kpi"><span>Dont espèces</span><strong>${money(s.salesCents - (s.cardSalesCents ?? 0))}</strong></div>
      <div class="kpi"><span>Dont carte (${s.cardSalesCount ?? 0})</span><strong>${money(s.cardSalesCents ?? 0)}</strong></div>
      <div class="kpi"><span>Ventes</span><strong>${s.salesCount}</strong></div>
      <div class="kpi"><span>Panier moyen</span><strong>${money(s.averageSaleCents)}</strong></div>
      <div class="kpi"><span>Monnaie rendue</span><strong>${money(s.changeGivenCents)}</strong></div>
      <div class="kpi"><span>Dépôts</span><strong>${money(s.depositsCents)}</strong></div>
      <div class="kpi"><span>Sorties (${s.payoutsCount})</span><strong>${money(s.payoutsCents)}</strong></div>
      <div class="kpi"><span>Réapprovisionné</span><strong>${money(s.refillsCents)}</strong></div>
      <div class="kpi"><span>Collecté</span><strong>${money(s.collectsCents)}</strong></div>
      <div class="kpi"><span>Ventes annulées</span><strong>${s.cancelledCount}</strong></div>
    </div>
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>Ventes par heure</h2></div>
        ${s.byHour.length ? `<div class="bars">${s.byHour
          .map((h) => `<div class="bar-row"><span>${String(h.hour).padStart(2, "0")}h</span><div class="bar"><span style="width:${(h.salesCents / maxHour) * 100}%"></span></div><b>${money(h.salesCents)}</b><small>${h.salesCount}</small></div>`)
          .join("")}</div>` : `<p class="muted">Aucune vente.</p>`}</section>
      <section class="card"><div class="card-head"><h2>Par vendeur</h2></div>
        ${s.byUser.length ? `<table class="table"><thead><tr><th>Vendeur</th><th class="num">Ventes</th><th class="num">Montant</th></tr></thead><tbody>${s.byUser
          .map((u) => `<tr><td>${esc(u.user)}</td><td class="num">${u.salesCount}</td><td class="num">${money(u.salesCents)}</td></tr>`)
          .join("")}</tbody></table>` : `<p class="muted">Aucune vente.</p>`}</section>
      <section class="card"><div class="card-head"><h2>Articles les plus vendus</h2></div>
        ${s.topItems?.length ? `<table class="table"><thead><tr><th>Article</th><th class="num">Quantité</th><th class="num">Montant</th></tr></thead><tbody>${s.topItems
          .map((i) => `<tr><td>${esc(i.name)}${i.code && !i.code.startsWith("ART-") ? ` <small class="muted mono">${esc(i.code)}</small>` : ""}</td><td class="num">${i.qty}</td><td class="num">${money(i.cents)}</td></tr>`)
          .join("")}</tbody></table>` : `<p class="muted">Aucun article scanné sur la période.</p>`}</section>
    </div>`;
}

async function closing(btn: HTMLButtonElement): Promise<void> {
  if (S.cashier.connection !== "connected") return toast("Connectez le terminal pour relever l'encaisse.", "error");
  if (!(await confirmDialog("Clôture de caisse", "Relever l'encaisse actuelle et éditer le rapport de clôture du jour ?", "Clôturer"))) return;
  await busy(btn, async () => {
    const r = await window.api.call<{ ok: boolean; message?: string; stats: PeriodStats; openingCents: number | null; closingCents: number; closingLines: DenomLine[]; expectedCents: number | null }>("stats.closing");
    if (!r.ok) return void toast(r.message ?? "Clôture impossible.", "error");
    const gap = r.expectedCents === null ? null : r.closingCents - r.expectedCents;
    const lines: TicketLine[] = [
      { label: "Encaisse d'ouverture", value: r.openingCents === null ? "-" : money(r.openingCents) },
      { label: "Ventes", value: `${r.stats.salesCount} • ${money(r.stats.salesCents)}` },
      { label: "Dont carte", value: `${r.stats.cardSalesCount ?? 0} • ${money(r.stats.cardSalesCents ?? 0)}` },
      { label: "Dont espèces", value: money(r.stats.salesCents - (r.stats.cardSalesCents ?? 0)) },
      { label: "Dépôts", value: money(r.stats.depositsCents) },
      { label: "Réapprovisionné", value: money(r.stats.refillsCents) },
      { label: "Sorties", value: money(r.stats.payoutsCents) },
      { label: "Collecté", value: money(r.stats.collectsCents) },
      { label: "Encaisse théorique", value: r.expectedCents === null ? "-" : money(r.expectedCents) },
      { label: "Encaisse réelle", value: money(r.closingCents), strong: true },
      { label: "Écart", value: gap === null ? "-" : money(gap), strong: true },
    ];
    await modal(
      (body, close) => {
        body.innerHTML = `<div class="detail">${lines.map((l) => `<div class="pay-row ${l.strong ? "pay-change" : ""}"><span>${esc(l.label)}</span><strong>${esc(l.value)}</strong></div>`).join("")}
          ${gap !== null && gap !== 0 ? `<p class="${Math.abs(gap) > 0 ? "error-text" : ""}">Écart constaté entre l'encaisse théorique et le contenu réel de la machine.</p>` : ""}
          ${r.openingCents === null ? `<p class="muted">Pas de relevé d'ouverture aujourd'hui : l'écart ne peut pas être calculé.</p>` : ""}
          <div class="row-actions"><button class="btn btn-lg" id="cl-print">Imprimer</button><button class="btn btn-primary btn-lg" id="cl-ok">Fermer</button></div></div>`;
        $("#cl-print", body).addEventListener("click", () => printTicket(ticketHtml(S.receipt!, "Clôture de caisse", null, [...lines, ...denomTicketLines(r.closingLines)], { user: S.user?.name }), S.receipt!.paperFormat));
        $("#cl-ok", body).addEventListener("click", () => close(true));
      },
      { title: "Clôture de caisse" }
    );
  });
}

// ================================================================ MAINTENANCE

function renderMaint(root: HTMLElement): void {
  const admin = S.user?.role === "admin";
  const tiles: HubTile[] = [
    actionTile("reset", "Réinitialiser", "Après un bourrage ou une erreur : les modules refont leur auto-test.", "reset", "device.reset", "Réinitialiser les modules billets et pièces ?"),
    {
      id: "status",
      label: "État du terminal",
      desc: "Vérifier que le terminal répond et voir son état.",
      icon: "pulse",
      action: async () => {
        if (S.cashier.connection !== "connected") return void toast("Terminal non connecté.", "error");
        const r = await window.api.call<OpResult & { code?: number }>("fcc.status");
        toast(r.ok ? `Le terminal répond : ${S.machine?.label ?? "prêt"}.` : r.message, r.ok ? "ok" : "error");
      },
    },
    actionTile("coins", "Rendre les pièces", "Rend les pièces restées dans l'entrée.", "coins", "coins.return"),
    {
      id: "diag",
      label: "Rapport d'assistance",
      desc: "Envoie au support un rapport sur le fonctionnement du logiciel (ou crée le fichier si pas d'internet).",
      icon: "doc",
      action: async () => {
        report(await window.api.call("diag.report"));
      },
    },
  ];
  if (admin) {
    tiles.push(
      actionTile("time", "Mettre à l'heure", "Règle l'horloge du terminal sur celle de ce PC.", "clock", "device.syncTime"),
      actionTile("reboot", "Redémarrer le terminal", "Le terminal Glory (pas ce PC) redémarre, quelques minutes.", "power", "device.reboot", "Redémarrer le terminal ? Il sera indisponible quelques minutes.", "danger"),
      actionTile("shutdown", "Éteindre le terminal", "Il faudra le rallumer à la main.", "power", "device.shutdown", "Éteindre le terminal ? Il faudra le rallumer manuellement.", "danger"),
      { id: "tech", label: "Mode technique", desc: "Journal, événements, firmware, fichiers de configuration.", icon: "code", render: renderTech }
    );
  }
  hub(root, tiles);
}

function renderTech(el: HTMLElement): void {
  el.innerHTML = `<div class="card">
    <div class="toolbar"><button class="btn" id="t-fw">Versions firmware</button>
      <input id="t-file" placeholder="Fichier (ex. GloryCo.xml)"><button class="btn" id="t-file-go">Lire le fichier</button></div>
    <div class="toolbar"><input id="t-cc" value="EUR" size="4" aria-label="Devise"><input id="t-fv" placeholder="Valeur en € (ex. 20 ou 0,50)" size="22"><select id="t-dev"><option value="1">Billets</option><option value="2">Pièces</option></select>
      <button class="btn" id="t-en">Autoriser</button><button class="btn" id="t-dis">Interdire</button></div>
    <pre id="t-out" class="pre"></pre>
    <h3>Journal</h3><div id="tech-log" class="pane"></div>
    <h3>Événements du terminal</h3><div id="tech-events" class="pane"></div></div>`;
  const logPane = $("#tech-log", el);
  for (const l of S.logs.slice(-400)) appendPaneLine(logPane, l);
  const evPane = $("#tech-events", el);
  for (const l of S.events.slice(-200)) appendPaneLine(evPane, l);
  const out = (raw: unknown) => ($("#t-out", el).textContent = typeof raw === "string" ? raw : JSON.stringify(raw ?? {}, null, 2));
  $("#t-fw", el).addEventListener("click", (e) =>
    void busy(e.currentTarget as HTMLButtonElement, async () => {
      const r = await window.api.call<OpResult & { raw?: unknown }>("tech.firmware");
      report(r);
      out(r.raw);
    })
  );
  $("#t-file-go", el).addEventListener("click", async (e) => {
    const name = $<HTMLInputElement>("#t-file", el).value.trim();
    if (!name) return toast("Nom de fichier requis.", "error");
    await busy(e.currentTarget as HTMLButtonElement, async () => {
      const r = await window.api.call<OpResult & { raw?: unknown }>("tech.settingFile", name);
      report(r);
      out(r.raw);
    });
  });
  const denom = (enabled: boolean) => async (e: Event) => {
    const raw = $<HTMLInputElement>("#t-fv", el).value.trim().replace(".", ",");
    if (!/^\d+(,\d{1,2})?$/.test(raw)) return toast("Valeur en euros (ex. 20 ou 0,50).", "error");
    const fv = String(parseAmount(raw));
    await busy(e.currentTarget as HTMLButtonElement, async () =>
      report(await window.api.call("tech.denomination", $<HTMLInputElement>("#t-cc", el).value.trim() || "EUR", fv, $<HTMLSelectElement>("#t-dev", el).value, enabled))
    );
  };
  $("#t-en", el).addEventListener("click", denom(true));
  $("#t-dis", el).addEventListener("click", denom(false));
}

// =================================================================== RÉGLAGES

async function renderSettings(root: HTMLElement): Promise<void> {
  const [fcc, receipt, app, users] = await Promise.all([
    window.api.call<FccConnectionConfig>("settings.fccGet"),
    window.api.call<ReceiptSettings>("settings.receiptGet"),
    window.api.call<AppSettings>("settings.appGet"),
    window.api.call<PublicUser[]>("users.list"),
  ]);
  root.innerHTML = `<div class="grid-2">
    <section class="card"><div class="card-head"><h2>Connexion au terminal</h2></div>
      <form class="form" id="f-fcc">
        <label>Adresse du terminal Glory<input name="soapEndpoint" value="${esc(fcc.soapEndpoint)}" placeholder="http://192.168.0.25/axis2/services/BrueBoxService"></label>
        <label>Adresse IP de cet ordinateur (pour les événements)<input name="callbackIp" value="${esc(fcc.callbackIp)}" placeholder="192.168.0.15"></label>
        <label>Port des événements<input name="eventTcpPort" type="number" value="${fcc.eventTcpPort}"></label>
        <label class="check"><input type="checkbox" name="rejectUnauthorized" ${fcc.rejectUnauthorized ? "checked" : ""}> Exiger un certificat HTTPS valide</label>
        <label>Utilisateur du terminal<input name="userId" value="${esc(fcc.userId)}"></label>
        <label>Mot de passe du terminal<input name="userPwd" type="password" value="${esc(fcc.userPwd)}"></label>
        <p class="muted small">L'utilisateur spécial « glory » est déconseillé par Glory pour les connexions. Ces champs ne servent que si le terminal a le « Session mode » et le « User check » activés.</p>
        <button class="btn btn-primary">Enregistrer</button>
      </form></section>

    <section class="card"><div class="card-head"><h2>Commerce et ticket</h2></div>
      <form class="form" id="f-receipt">
        <label>Nom du commerce<input name="companyName" value="${esc(receipt.companyName)}"></label>
        <label>Téléphone / TVA / adresse<input name="companyLine2" value="${esc(receipt.companyLine2)}"></label>
        <label>Message de fin de ticket<input name="footerMessage" value="${esc(receipt.footerMessage)}"></label>
        <label>Papier<select name="paperFormat">${(["58mm", "80mm", "A4"] as const).map((p) => `<option value="${p}" ${receipt.paperFormat === p ? "selected" : ""}>${p === "A4" ? "Feuille A4" : `Rouleau ${p.replace("mm", " mm")}`}</option>`).join("")}</select></label>
        <div class="row-actions"><button class="btn btn-primary">Enregistrer</button><button type="button" class="btn" id="f-test">Ticket de test</button></div>
      </form></section>

    <section class="card"><div class="card-head"><h2>Préférences</h2></div>
      <form class="form" id="f-app">
        <label data-no-i18n>Langue / Taal<select id="ui-lang"><option value="fr" ${LANG === "fr" ? "selected" : ""}>Français</option><option value="nl" ${LANG === "nl" ? "selected" : ""}>Nederlands</option></select></label>
        <label>Taille de l'affichage<select id="ui-scale">${[
          ["auto", "Automatique (s'adapte à la fenêtre)"],
          ["0.7", "70 %"],
          ["0.8", "80 %"],
          ["0.9", "90 %"],
          ["1", "100 %"],
          ["1.1", "110 %"],
          ["1.25", "125 %"],
        ]
          .map(([v, l]) => `<option value="${v}" ${uiScalePref() === v ? "selected" : ""}>${l}</option>`)
          .join("")}</select></label>
        <label class="check"><input type="checkbox" name="cardPayments" ${app.cardPayments !== false ? "checked" : ""}> Proposer le paiement par carte / sans contact (bouton « Carte » dans la vente)</label>
        <label class="check"><input type="checkbox" name="autoPrintReceipt" ${app.autoPrintReceipt ? "checked" : ""}> Imprimer le ticket automatiquement après chaque vente</label>
        <label>Méthode d'impression<select name="printMethod">${(
          [
            ["system", "Fenêtre d'impression du système"],
            ["browser", "Navigateur par défaut (recommandé)"],
          ] as const
        )
          .map(([v, l]) => `<option value="${v}" ${app.printMethod === v ? "selected" : ""}>${l}</option>`)
          .join("")}</select></label>
        <p class="muted small">Navigateur : le ticket s'ouvre dans Chrome / Edge / Firefox, qui lance l'impression. Testez avec « Ticket de test ».</p>
        <label class="check"><input type="checkbox" name="autoConnect" ${app.autoConnect ? "checked" : ""}> Connecter le terminal à l'ouverture de session</label>
        <label>Fond de caisse en montant simple, si aucune composition n'est réglée (€)<input name="defaultFloat" type="number" min="0" step="1" value="${app.defaultFloatCents / 100}"></label>
        <label>Verrouillage automatique après (minutes, 0 = jamais)<input name="autoLockMinutes" type="number" min="0" value="${app.autoLockMinutes}"></label>
        <button class="btn btn-primary">Enregistrer</button>
      </form></section>

    <section class="card"><div class="card-head"><h2>Scanner de codes-barres</h2></div>
      <p class="muted small">Datalogic / QuickScan et tout scanner USB : branchez-le, il fonctionne tout de suite (mode « clavier USB » d'usine). Si rien ne se passe, scannez dans son guide rapide les codes « USB Keyboard » puis « Enter » (suffixe).</p>
      <div class="scan-test" id="scan-test"><span>Scannez un code pour tester</span><strong id="scan-last">${esc(scanner.last || "en attente…")}</strong></div>
      <form class="form" id="f-scan">
        <label class="check"><input type="checkbox" name="scanEmbeddedPrice" ${app.scanEmbeddedPrice ? "checked" : ""}> Lire le prix dans les codes-barres de balance (étiquettes « poids/prix »)</label>
        <label>Préfixes de ces codes<input name="scanPricePrefixes" value="${esc(app.scanPricePrefixes)}" placeholder="21 22 23 24"></label>
        <p class="muted small">Les étiquettes de balance commencent par 2 suivi d'un chiffre ; le prix est lu dans les chiffres 8 à 12. Demandez au fournisseur de la balance quels préfixes elle utilise.</p>
        <button class="btn btn-primary">Enregistrer</button>
      </form></section>

    <section class="card card-wide"><div class="card-head"><h2>Fond de caisse</h2></div><div id="float-editor"></div></section>

    <section class="card" id="upd-card"><div class="card-head"><h2>Mises à jour</h2></div><div id="upd-body" class="muted">…</div></section>

    <section class="card" id="lic-card"><div class="card-head"><h2>Licence</h2></div><div id="lic-body" class="muted">…</div></section>

    <section class="card"><div class="card-head"><h2>Utilisateurs</h2><button class="btn" id="u-add">Ajouter</button></div>
      <table class="table"><tbody>${users
        .map((u) => `<tr><td>${esc(u.name)}</td><td>${u.role === "admin" ? "Administrateur" : "Vendeur"}</td><td class="num"><button class="btn btn-sm" data-edit="${esc(u.name)}" data-role="${u.role}">Modifier</button>${u.name !== S.user?.name ? ` <button class="btn btn-sm btn-danger" data-del="${esc(u.name)}">Supprimer</button>` : ""}</td></tr>`)
        .join("")}</tbody></table></section>
  </div>`;

  const renderLicense = (l: LicenseStatus) => {
    const body = $("#lic-body", root);
    body.className = "";
    body.innerHTML = `<div class="detail">
        <div class="pay-row"><span>État</span><strong class="${l.state === "valid" ? "ok-text" : "error-text"}">${esc(l.message)}</strong></div>
        ${l.client ? `<div class="pay-row"><span>Client</span><strong>${esc(l.client)}</strong></div>` : ""}
        <div class="pay-row"><span>Validité</span><strong>${l.expiresAt ? `jusqu'au ${new Date(l.expiresAt).toLocaleDateString(LOCALE)}` : "définitive"}</strong></div>
        ${l.keyHint ? `<div class="pay-row"><span>Clé</span><strong>${esc(l.keyHint)}</strong></div>` : ""}
        <div class="pay-row"><span>Code de ce PC</span><strong>${esc(l.machineCode)}</strong></div>
        <div class="pay-row"><span>Sans internet</span><strong>${l.refreshBy ? `contrôle en ligne avant le ${new Date(l.refreshBy).toLocaleDateString(LOCALE)}` : l.state === "valid" ? "fonctionne sans limite" : "-"}</strong></div>
      </div>
      <div class="row-actions"><button class="btn" id="lic-check">Vérifier maintenant</button><button class="btn btn-danger" id="lic-remove">Retirer la licence de ce PC</button></div>`;
    $("#lic-check", body).addEventListener("click", (e) =>
      void busy(e.currentTarget as HTMLButtonElement, async () => {
        const r = await window.api.call<LicenseStatus>("license.refresh");
        toast(r.state === "valid" ? "Licence vérifiée." : r.message, r.state === "valid" ? "ok" : "error");
        if (r.state === "valid") renderLicense(r);
      })
    );
    $("#lic-remove", body).addEventListener("click", async () => {
      const text = "Le logiciel sera bloqué sur ce PC jusqu'à la saisie d'une clé de produit. Pour l'utiliser sur un autre PC, demandez aussi le transfert de la licence à votre fournisseur.";
      if (!(await confirmDialog("Retirer la licence", text, "Retirer", true))) return;
      await window.api.call("license.remove");
    });
  };
  void window.api.call<LicenseStatus>("license.status").then(renderLicense);
  void window.api.call<UpdateState>("update.status").then((u) => renderUpdate($("#upd-body", root), u));

  $<HTMLSelectElement>("#ui-lang", root).addEventListener("change", (e) => setLang((e.currentTarget as HTMLSelectElement).value === "nl" ? "nl" : "fr"));

  // Taille de l'affichage : appliquée tout de suite, mémorisée sur ce PC.
  $<HTMLSelectElement>("#ui-scale", root).addEventListener("change", (e) => {
    try {
      localStorage.setItem("uiScale", (e.currentTarget as HTMLSelectElement).value);
    } catch {
      /* stockage indisponible : réglage valable jusqu'au prochain démarrage */
    }
    applyZoom();
  });

  // Scanner : chaque scan s'affiche ici (test), sans ouvrir la vente.
  onScan((code) => {
    const el = document.getElementById("scan-last");
    if (el) el.textContent = code;
    document.getElementById("scan-test")?.classList.add("is-ok");
  });
  $<HTMLFormElement>("#f-scan", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const v = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
    S.settings = await window.api.call<AppSettings>("settings.appSave", { ...(S.settings ?? app), scanEmbeddedPrice: !!v.scanEmbeddedPrice, scanPricePrefixes: v.scanPricePrefixes ?? "" });
    ($<HTMLInputElement>("[name=scanPricePrefixes]", f)).value = S.settings.scanPricePrefixes;
    toast("Enregistré.", "ok");
  });
  floatEditor($("#float-editor", root), app.floatComposition ?? {}, async (c) => {
    S.settings = await window.api.call<AppSettings>("settings.appSave", { ...(S.settings ?? app), floatComposition: c });
    const t = compositionTotal(S.settings.floatComposition);
    toast(t ? `Fond de caisse enregistré : ${money(t)}.` : "Composition retirée : le montant simple sera utilisé.", "ok");
  });

  const formObj = (f: HTMLFormElement) => Object.fromEntries(new FormData(f).entries()) as Record<string, string>;

  $<HTMLFormElement>("#f-fcc", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const v = formObj(f);
    const port = Number(v.eventTcpPort);
    if (!/^https?:\/\/.+/.test(v.soapEndpoint)) return toast("L'adresse du terminal doit commencer par http:// ou https://", "error");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v.callbackIp.trim())) return toast("Adresse IP de cet ordinateur invalide (ex. 192.168.0.15).", "error");
    if (!(port > 0 && port < 65536)) return toast("Port invalide.", "error");
    await window.api.call("settings.fccSave", {
      soapEndpoint: v.soapEndpoint.trim(),
      callbackIp: v.callbackIp.trim(),
      eventTcpPort: port,
      rejectUnauthorized: !!v.rejectUnauthorized,
      userId: v.userId.trim(),
      userPwd: v.userPwd,
    });
    toast(S.cashier.connection === "connected" ? "Enregistré. Reconnectez le terminal pour l'appliquer." : "Enregistré.", "ok");
  });

  $<HTMLFormElement>("#f-receipt", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = formObj(e.currentTarget as HTMLFormElement);
    S.receipt = await window.api.call<ReceiptSettings>("settings.receiptSave", { ...receipt, companyName: v.companyName.trim(), companyLine2: v.companyLine2.trim(), footerMessage: v.footerMessage.trim(), paperFormat: v.paperFormat });
    toast("Enregistré.", "ok");
    const brand = $(".rail-brand span");
    if (brand) brand.textContent = S.receipt.companyName || "Glory FCC";
  });
  $("#f-test", root).addEventListener("click", () => {
    const s = S.receipt ?? receipt;
    printTicket(ticketHtml(s, "Ticket de test", 0, [{ label: "TOTAL", value: money(1234), strong: true }, { label: "Espèces reçues", value: money(2000) }, { label: "Rendu", value: money(766) }], { barcodeCents: 1234, user: S.user?.name }), s.paperFormat);
  });

  $<HTMLFormElement>("#f-app", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = formObj(e.currentTarget as HTMLFormElement);
    S.settings = await window.api.call<AppSettings>("settings.appSave", {
      ...(S.settings ?? app),
      autoPrintReceipt: !!v.autoPrintReceipt,
      cardPayments: !!v.cardPayments,
      autoConnect: !!v.autoConnect,
      defaultFloatCents: Math.round(Number(v.defaultFloat || 0) * 100),
      autoLockMinutes: Number(v.autoLockMinutes || 0),
      printMethod: v.printMethod as AppSettings["printMethod"],
    });
    toast("Enregistré.", "ok");
  });

  const editUser = (name = "", role: Role = "vendeur") =>
    modal<boolean>(
      (body, close) => {
        body.innerHTML = `<form class="form" id="u-form">
          <label>Nom<input name="name" value="${esc(name)}" ${name ? "readonly" : ""} required maxlength="40"></label>
          <label>Profil<select name="role"><option value="vendeur" ${role === "vendeur" ? "selected" : ""}>Vendeur</option><option value="admin" ${role === "admin" ? "selected" : ""}>Administrateur</option></select></label>
          <label>${name ? "Nouveau code PIN" : "Code PIN"} (4 à 8 chiffres)<input name="pin" type="password" inputmode="numeric" required pattern="\\d{4,8}"></label>
          <div class="dialog-actions"><button class="btn btn-primary">Enregistrer</button></div></form>`;
        $<HTMLFormElement>("#u-form", body).addEventListener("submit", async (e) => {
          e.preventDefault();
          const v = formObj(e.currentTarget as HTMLFormElement);
          const r = await window.api.call("users.save", v.name.trim(), v.role, v.pin);
          if (!r.ok) return void toast(r.message, "error");
          toast("Utilisateur enregistré.", "ok");
          close(true);
        });
      },
      { title: name ? `Modifier ${name}` : "Nouvel utilisateur" }
    ).then((saved) => {
      if (saved) void renderSettings(root);
    });

  $("#u-add", root).addEventListener("click", () => void editUser());
  for (const b of $$<HTMLButtonElement>("[data-edit]", root)) b.addEventListener("click", () => void editUser(b.dataset.edit!, b.dataset.role as Role));
  for (const b of $$<HTMLButtonElement>("[data-del]", root))
    b.addEventListener("click", async () => {
      if (!(await confirmDialog("Supprimer", `Supprimer l'utilisateur ${b.dataset.del} ?`, "Supprimer", true))) return;
      const r = await window.api.call("users.delete", b.dataset.del);
      if (report(r, "Utilisateur supprimé.")) void renderSettings(root);
    });
}
