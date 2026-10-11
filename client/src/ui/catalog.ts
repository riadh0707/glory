/**
 * Catalogue d'articles (Gestion → Articles) et composition du fond de
 * caisse (Réglages).
 */

// ================================================================ ARTICLES

/** Vignette d'un article : sa photo, sinon ses initiales sur une couleur stable. */
function productThumb(p: Product, size: "sm" | "md" = "md"): string {
  if (p.image) return `<img class="pthumb pthumb-${size}" src="${p.image}" alt="" draggable="false">`;
  const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  let h = 0;
  for (const c of p.name) h = (h * 7 + c.charCodeAt(0) * 47) % 360;
  return `<span class="pthumb pthumb-${size} pthumb-none" style="--h:${h}">${esc(initials || "?")}</span>`;
}

function stockBadge(p: Product): string {
  if (typeof p.stock !== "number") return "";
  const cls = p.stock <= 0 ? "stock-out" : p.stock <= 3 ? "stock-low" : "stock-ok";
  return `<span class="stock-badge ${cls}">${p.stock <= 0 ? "rupture" : `stock ${p.stock}`}</span>`;
}

/** Fiche article (création / modification). Renvoie true si enregistrée. */
async function editProduct(p: Product | null, code = ""): Promise<boolean> {
  const cats = await window.api.call<string[]>("products.categories");
  let image = p?.image ?? "";
  const saved = await modal<boolean>(
    (mb, close) => {
      mb.innerHTML = `<form class="form product-form" id="pr-form">
          <div class="pf-image">
            <div class="pf-preview" id="pf-preview"></div>
            <button type="button" class="btn btn-sm" id="pf-pick">Choisir une photo</button>
            <button type="button" class="btn btn-sm btn-danger" id="pf-clear">Retirer</button>
          </div>
          <div class="pf-fields">
            <label>Nom de l'article<input name="name" required maxlength="120" value="${esc(p?.name ?? "")}" placeholder="ex. Croissant"></label>
            <label>Prix (€)<input name="price" inputmode="decimal" required value="${p ? (p.priceCents / 100).toFixed(2).replace(".", ",") : ""}" placeholder="ex. 1,20"></label>
            <label>Rayon / catégorie<input name="category" maxlength="60" list="pf-cats" value="${esc(p?.category ?? "")}" placeholder="ex. Boulangerie"><datalist id="pf-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
            <label>Code-barres <span class="muted small">(laisser vide si l'article n'en a pas)</span><input name="code" class="mono" maxlength="48" value="${esc(p?.code ?? code)}" placeholder="Scannez ou tapez le code"></label>
            <label>Stock <span class="muted small">(laisser vide pour ne pas suivre le stock)</span><input name="stock" type="number" step="1" value="${typeof p?.stock === "number" ? p.stock : ""}"></label>
          </div>
          <div class="dialog-actions"><button type="button" class="btn" data-no>Annuler</button><button class="btn btn-primary">Enregistrer</button></div>
        </form>`;
      const preview = () => ($("#pf-preview", mb).innerHTML = image ? `<img src="${image}" alt="">` : `<span class="muted small">Pas de photo</span>`);
      preview();
      $("#pf-pick", mb).addEventListener("click", (e) =>
        void busy(e.currentTarget as HTMLButtonElement, async () => {
          const r = await window.api.call<OpResult & { image?: string }>("products.pickImage");
          if (r.ok && r.image) {
            image = r.image;
            preview();
          } else if (r.message !== "Aucune image choisie.") toast(r.message, "error");
        })
      );
      $("#pf-clear", mb).addEventListener("click", () => {
        image = "";
        preview();
      });
      const f = $<HTMLFormElement>("#pr-form", mb);
      $<HTMLInputElement>(p || code ? "[name=name]" : "[name=name]", mb).focus();
      $("[data-no]", mb).addEventListener("click", () => close(false));
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
        const cents = readEuros(v.price ?? "");
        if (Number.isNaN(cents)) return toast("Prix invalide (ex. 1,20).", "error");
        const r = await window.api.call<OpResult>(
          "products.save",
          { code: (v.code ?? "").trim(), name: v.name, priceCents: cents, category: v.category, image, stock: v.stock === "" ? null : Number(v.stock) },
          p?.code
        );
        if (!r.ok) return toast(r.message, "error");
        close(true);
      });
    },
    { title: p ? "Modifier l'article" : "Nouvel article", wide: true }
  );
  if (saved) toast("Article enregistré.", "ok");
  return !!saved;
}

function renderProducts(el: HTMLElement): void {
  el.innerHTML = `<div class="card">
      <div class="toolbar">
        <input id="pr-search" type="search" placeholder="Rechercher un article, un rayon ou un code…" autocomplete="off">
        <select id="pr-cat"><option value="">Tous les rayons</option></select>
        <button class="btn btn-primary" id="pr-add">Nouvel article</button>
        <button class="btn" id="pr-import">Importer (Excel/CSV)</button>
        <button class="btn" id="pr-export">Exporter</button>
      </div>
      <p class="muted small">Articles avec ou sans code-barres (pain, fruits, produits maison…). Ils apparaissent dans le bouton « Articles » de la vente. Import : « code;nom;prix;rayon;stock » (seuls nom et prix sont obligatoires). Scanner un article ici ouvre sa fiche.</p>
      <div id="pr-alerts"></div>
      <div id="pr-body"></div>
    </div>`;
  let all: Product[] = [];
  const body = $("#pr-body", el);
  const search = $<HTMLInputElement>("#pr-search", el);
  const catSel = $<HTMLSelectElement>("#pr-cat", el);

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const cat = catSel.value;
    const rows = all.filter((p) => (!cat || p.category === cat) && (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.category ?? "").toLowerCase().includes(q)));
    const low = all.filter((p) => typeof p.stock === "number" && p.stock <= 3);
    $("#pr-alerts", el).innerHTML = low.length
      ? `<div class="stock-note">${icon("refill")}<div><strong>${low.length} article(s) à réapprovisionner</strong><br>${low
          .slice(0, 8)
          .map((p) => `${esc(p.name)} (${p.stock! <= 0 ? "rupture" : `reste ${p.stock}`})`)
          .join(", ")}${low.length > 8 ? "…" : ""}</div></div>`
      : "";
    body.innerHTML = rows.length
      ? `<p class="muted small">${rows.length} article(s)${rows.length !== all.length ? ` sur ${all.length}` : ""}</p>
        <table class="table products-table"><thead><tr><th></th><th>Article</th><th>Rayon</th><th>Code-barres</th><th class="num">Prix</th><th class="num">Stock</th><th></th></tr></thead><tbody>${rows
          .slice(0, 500)
          .map(
            (p) => `<tr><td>${productThumb(p, "sm")}</td><td><strong>${esc(p.name)}</strong></td><td>${esc(p.category ?? "")}</td>
              <td class="mono">${p.code.startsWith("ART-") ? `<span class="muted">sans code</span>` : esc(p.code)}</td><td class="num">${money(p.priceCents)}</td>
              <td class="num">${typeof p.stock === "number" ? stockBadge(p) : `<span class="muted">-</span>`}</td>
              <td class="num"><button class="btn btn-sm" data-edit="${esc(p.code)}">Modifier</button> <button class="btn btn-sm btn-danger" data-del="${esc(p.code)}">Supprimer</button></td></tr>`
          )
          .join("")}</tbody></table>${rows.length > 500 ? `<p class="muted small">Affinez la recherche pour voir les autres articles.</p>` : ""}`
      : `<div class="empty small"><p>${all.length ? "Aucun article ne correspond." : "Aucun article. Ajoutez-en un, scannez un produit ou importez votre liste."}</p></div>`;
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
    const cats = [...new Set(all.map((p) => p.category ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    const cur = catSel.value;
    catSel.innerHTML = `<option value="">Tous les rayons</option>${cats.map((c) => `<option ${c === cur ? "selected" : ""}>${esc(c)}</option>`).join("")}`;
    draw();
  };
  const edit = async (p: Product | null, code = "") => {
    if (await editProduct(p, code)) await load();
  };

  search.addEventListener("input", draw);
  catSel.addEventListener("change", draw);
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

/**
 * Liste des articles à la caisse : rayons, recherche, grandes vignettes.
 * Chaque appui ajoute 1 au panier ; le nombre déjà pris s'affiche sur la vignette.
 */
async function productPicker(onAdd: (p: Product) => void, inBasket: (code: string) => number): Promise<void> {
  const all = await window.api.call<Product[]>("products.list");
  if (!Array.isArray(all) || all.length === 0) {
    toast(S.user?.role === "admin" ? "Aucun article : créez-en dans Gestion → Articles." : "Aucun article dans le catalogue.", "info");
    return;
  }
  const cats = [...new Set(all.map((p) => p.category ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  let cat = "";
  await modal<boolean>(
    (mb, close) => {
      mb.innerHTML = `<div class="picker">
          <div class="picker-top">
            <input type="search" id="pk-search" placeholder="Rechercher…" autocomplete="off">
            <div class="choice picker-cats" id="pk-cats"><button class="btn active" data-c="">Tout</button>${cats.map((c) => `<button class="btn" data-c="${esc(c)}">${esc(c)}</button>`).join("")}</div>
          </div>
          <div class="picker-grid" id="pk-grid"></div>
          <div class="dialog-actions"><span class="muted" id="pk-info"></span><button class="btn btn-primary btn-lg" data-done>Terminé</button></div>
        </div>`;
      const grid = $("#pk-grid", mb);
      const search = $<HTMLInputElement>("#pk-search", mb);
      const draw = () => {
        const q = search.value.trim().toLowerCase();
        const rows = all.filter((p) => (!cat || p.category === cat) && (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)));
        grid.innerHTML = rows.length
          ? rows
              .map((p) => {
                const n = inBasket(p.code);
                return `<button class="pick-tile ${n ? "is-on" : ""} ${typeof p.stock === "number" && p.stock <= 0 ? "is-out" : ""}" data-code="${esc(p.code)}">
                  ${productThumb(p)}<span class="pt-name">${esc(p.name)}</span><span class="pt-price">${money(p.priceCents)}</span>${stockBadge(p)}
                  ${n ? `<span class="pt-count">${n}</span>` : ""}</button>`;
              })
              .join("")
          : `<p class="muted">Aucun article.</p>`;
      };
      grid.addEventListener("click", (e) => {
        const t = (e.target as HTMLElement).closest(".pick-tile") as HTMLElement | null;
        if (!t) return;
        const p = all.find((x) => x.code === t.dataset.code);
        if (!p) return;
        onAdd(p);
        $("#pk-info", mb).textContent = `${p.name} ajouté`;
        draw();
      });
      for (const b of $$<HTMLButtonElement>("#pk-cats button", mb))
        b.addEventListener("click", () => {
          cat = b.dataset.c ?? "";
          for (const x of $$("#pk-cats button", mb)) x.classList.toggle("active", x === b);
          draw();
        });
      search.addEventListener("input", draw);
      $("[data-done]", mb).addEventListener("click", () => close(true));
      draw();
    },
    { title: "Articles", wide: true }
  );
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
