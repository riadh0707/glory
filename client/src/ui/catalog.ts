/**
 * Catalogue d'articles (Gestion → Articles) et composition du fond de
 * caisse (Réglages).
 */

// ================================================================ ARTICLES

function renderProducts(el: HTMLElement): void {
  el.innerHTML = `<div class="card">
      <div class="toolbar">
        <input id="pr-search" type="search" placeholder="Rechercher un article ou un code…" autocomplete="off">
        <button class="btn btn-primary" id="pr-add">${icon("refill")} Nouvel article</button>
        <button class="btn" id="pr-import">Importer (Excel/CSV)</button>
        <button class="btn" id="pr-export">Exporter</button>
      </div>
      <p class="muted small">Scannez un article : s'il existe, sa fiche s'ouvre ; sinon une nouvelle fiche est préremplie avec son code. Import : fichier « code;nom;prix » (ex. <code>5449000000996;Coca-Cola 33 cl;1,20</code>).</p>
      <div id="pr-body"></div>
    </div>`;
  let all: Product[] = [];
  const body = $("#pr-body", el);
  const search = $<HTMLInputElement>("#pr-search", el);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.code.includes(q)) : all;
    body.innerHTML = rows.length
      ? `<p class="muted small">${rows.length} article(s)${q ? ` sur ${all.length}` : ""}</p>
        <table class="table"><thead><tr><th>Article</th><th>Code-barres</th><th class="num">Prix</th><th></th></tr></thead><tbody>${rows
          .slice(0, 500)
          .map(
            (p) => `<tr><td><strong>${esc(p.name)}</strong></td><td class="mono">${esc(p.code)}</td><td class="num">${money(p.priceCents)}</td>
              <td class="num"><button class="btn btn-sm" data-edit="${esc(p.code)}">Modifier</button> <button class="btn btn-sm btn-danger" data-del="${esc(p.code)}">Supprimer</button></td></tr>`
          )
          .join("")}</tbody></table>${rows.length > 500 ? `<p class="muted small">Affinez la recherche pour voir les autres articles.</p>` : ""}`
      : `<div class="empty small"><p>${all.length ? "Aucun article ne correspond." : "Aucun article. Scannez un produit ou importez votre liste."}</p></div>`;
    for (const b of $$<HTMLButtonElement>("[data-edit]", body)) b.addEventListener("click", () => void edit(all.find((p) => p.code === b.dataset.edit) ?? null));
    for (const b of $$<HTMLButtonElement>("[data-del]", body))
      b.addEventListener("click", async () => {
        const p = all.find((x) => x.code === b.dataset.del);
        if (!p || !(await confirmDialog("Supprimer l'article", `Supprimer « ${p.name} » du catalogue ?`, "Supprimer", true))) return;
        report(await window.api.call("products.remove", p.code));
        await load();
      });
  };
  const load = async () => {
    const r = await window.api.call<Product[]>("products.list");
    all = Array.isArray(r) ? r : [];
    draw();
  };

  const edit = async (p: Product | null, code = "") => {
    const saved = await modal<boolean>(
      (mb, close) => {
        mb.innerHTML = `<form class="form" id="pr-form">
            <label>Code-barres<input name="code" class="mono" required maxlength="48" value="${esc(p?.code ?? code)}" placeholder="Scannez ou tapez le code"></label>
            <label>Nom de l'article<input name="name" required maxlength="120" value="${esc(p?.name ?? "")}"></label>
            <label>Prix (€)<input name="price" inputmode="decimal" required value="${p ? String(p.priceCents / 100).replace(".", ",") : ""}" placeholder="ex. 1,20"></label>
            <div class="dialog-actions"><button type="button" class="btn" data-no>Annuler</button><button class="btn btn-primary">Enregistrer</button></div>
          </form>`;
        const f = $<HTMLFormElement>("#pr-form", mb);
        $<HTMLInputElement>(p || code ? "[name=name]" : "[name=code]", mb).focus();
        $("[data-no]", mb).addEventListener("click", () => close(false));
        f.addEventListener("submit", async (e) => {
          e.preventDefault();
          const v = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
          const cents = readEuros(v.price ?? "");
          if (Number.isNaN(cents)) return toast("Prix invalide (ex. 1,20).", "error");
          const r = await window.api.call<OpResult>("products.save", { code: v.code, name: v.name, priceCents: cents }, p?.code);
          if (!r.ok) return toast(r.message, "error");
          close(true);
        });
      },
      { title: p ? "Modifier l'article" : "Nouvel article" }
    );
    if (saved) {
      toast("Article enregistré.", "ok");
      await load();
    }
  };

  search.addEventListener("input", draw);
  $("#pr-add", el).addEventListener("click", () => void edit(null));
  $("#pr-import", el).addEventListener("click", (e) =>
    void busy(e.currentTarget as HTMLButtonElement, async () => {
      const r = await window.api.call<OpResult & { errors?: string[] }>("products.import");
      report(r);
      if (r.errors?.length) toast(r.errors.slice(0, 3).join(" · "), "error");
      await load();
    })
  );
  $("#pr-export", el).addEventListener("click", (e) => void busy(e.currentTarget as HTMLButtonElement, async () => report(await window.api.call("products.export"))));
  onScan((code) => {
    const p = all.find((x) => x.code === code);
    void edit(p ?? null, p ? "" : code);
  });
  void load();
}

// ======================================================= FOND DE CAISSE

const EURO_NOTES = [50000, 20000, 10000, 5000, 2000, 1000, 500];
const EURO_COINS = [200, 100, 50, 20, 10, 5, 2, 1];

function compositionTotal(c: Record<string, number>): number {
  return Object.entries(c).reduce((s, [fv, n]) => s + Number(fv) * n, 0);
}

function compositionSummary(c: Record<string, number>): string {
  return Object.entries(c)
    .filter(([, n]) => n > 0)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([fv, n]) => `${n} × ${faceLabel(fv)}`)
    .join(", ");
}

/** Éditeur de la composition du fond de caisse (billets et pièces à laisser). */
function floatEditor(host: HTMLElement, initial: Record<string, number>, onSave: (c: Record<string, number>) => Promise<void>): void {
  const comp: Record<string, number> = { ...initial };
  const cell = (fv: number) => {
    const line = { cc: "EUR", fv: String(fv), devid: fv >= 500 ? "1" : "2", piece: 0 };
    return `<div class="pick" data-fv="${fv}">${cashHtml(line, "sm")}
      <div class="pick-ctl"><button type="button" class="btn" data-d="-1">−</button><input type="number" min="0" max="5000" value="${comp[fv] ?? 0}" aria-label="Nombre de ${faceLabel(fv)}"><button type="button" class="btn" data-d="1">+</button></div>
      <small data-sum></small></div>`;
  };
  host.innerHTML = `<p class="muted small">Ce que la machine doit garder lors d'une collecte « Laisser un fond de caisse » : par exemple 1 billet de 20 €, 10 pièces de 2 €… Tout le reste part vers la cassette.</p>
    <h3>Billets</h3><div class="pick-grid float-grid">${EURO_NOTES.map(cell).join("")}</div>
    <h3>Pièces</h3><div class="pick-grid float-grid">${EURO_COINS.map(cell).join("")}</div>
    <div class="float-total"><span>Fond de caisse</span><strong id="fl-total"></strong></div>
    <div class="row-actions"><button type="button" class="btn" id="fl-reset">Tout remettre à zéro</button><button type="button" class="btn btn-primary" id="fl-save">Enregistrer le fond de caisse</button></div>`;
  const refresh = () => {
    for (const p of $$<HTMLElement>(".pick", host)) {
      const fv = Number(p.dataset.fv);
      const n = comp[fv] ?? 0;
      $<HTMLInputElement>("input", p).value = String(n);
      $("[data-sum]", p).textContent = n ? money(n * fv) : "";
      p.classList.toggle("is-on", n > 0);
    }
    const t = compositionTotal(comp);
    $("#fl-total", host).textContent = t ? money(t) : "non défini (montant simple utilisé)";
  };
  for (const p of $$<HTMLElement>(".pick", host)) {
    const fv = Number(p.dataset.fv);
    p.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-d]") as HTMLButtonElement | null;
      if (!b) return;
      comp[fv] = Math.max(0, Math.min(5000, (comp[fv] ?? 0) + Number(b.dataset.d)));
      refresh();
    });
    $<HTMLInputElement>("input", p).addEventListener("input", (e) => {
      const n = Math.floor(Number((e.target as HTMLInputElement).value) || 0);
      comp[fv] = Math.max(0, Math.min(5000, n));
      $("[data-sum]", p).textContent = comp[fv] ? money(comp[fv] * fv) : "";
      $("#fl-total", host).textContent = compositionTotal(comp) ? money(compositionTotal(comp)) : "non défini (montant simple utilisé)";
    });
  }
  $("#fl-reset", host).addEventListener("click", () => {
    for (const k of Object.keys(comp)) delete comp[k];
    refresh();
  });
  $("#fl-save", host).addEventListener("click", (e) =>
    void busy(e.currentTarget as HTMLButtonElement, async () => {
      const clean = Object.fromEntries(Object.entries(comp).filter(([, n]) => n > 0)) as Record<string, number>;
      await onSave(clean);
    })
  );
  refresh();
}
