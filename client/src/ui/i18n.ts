/**
 * Langue de l'interface : français (langue du code) ou néerlandais.
 *
 * Les textes restent écrits en français dans le code ; en néerlandais, ils
 * sont traduits au moment où ils s'affichent (nœuds texte et attributs
 * visibles), à partir du dictionnaire scripts/i18n/nl.json (copié en
 * dist/ui/i18n-nl.js). Les phrases avec une partie variable (« Collecte
 * effectuée : 152,50 € ») sont des modèles {0}, {1}…
 *
 * Choix mémorisé sur ce PC (localStorage) ; changer de langue recharge
 * l'interface (dates et montants au format de la langue).
 */

type Lang = "fr" | "nl";

const LANG: Lang = (() => {
  try {
    return localStorage.getItem("lang") === "nl" ? "nl" : "fr";
  } catch {
    return "fr";
  }
})();

/** Locale des dates et des montants. */
const LOCALE = LANG === "nl" ? "nl-BE" : "fr-BE";

declare const I18N_NL: Record<string, string> | undefined;

const i18n = (() => {
  const exact = new Map<string, string>();
  const patterns: Array<{ re: RegExp; out: string }> = [];
  const cache = new Map<string, string>();
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  if (LANG === "nl" && typeof I18N_NL === "object" && I18N_NL) {
    for (const [fr, nl] of Object.entries(I18N_NL)) {
      const k = norm(fr);
      if (/\{\d+\}/.test(k)) {
        const re = new RegExp("^" + k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\d+)\}/g, "(.+?)") + "$");
        patterns.push({ re, out: nl });
      } else exact.set(k, nl);
    }
    // Les modèles les plus précis (le plus de texte fixe) d'abord.
    patterns.sort((a, b) => b.re.source.replace(/\(\.\+\?\)/g, "").length - a.re.source.replace(/\(\.\+\?\)/g, "").length);
  }

  function core(s: string): string {
    const k = norm(s);
    if (!k) return s;
    const hit = exact.get(k);
    if (hit !== undefined) return hit;
    for (const p of patterns) {
      const m = p.re.exec(k);
      if (m) return p.out.replace(/\{(\d+)\}/g, (_, i: string) => exact.get(norm(m[Number(i) + 1] ?? "")) ?? m[Number(i) + 1] ?? "");
    }
    return s;
  }

  /** Traduit un texte affiché (garde les espaces de début et de fin). */
  function t(text: string): string {
    if (LANG === "fr" || !text || !/[A-Za-zÀ-ÿ]/.test(text)) return text;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    const translated = core(m[2]);
    const out = translated === m[2] ? text : m[1] + translated + m[3];
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
    return out;
  }

  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);

  function translateNode(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      const p = root.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest("[data-no-i18n]")) return;
      const v = root.nodeValue ?? "";
      const tr = t(v);
      if (tr !== v) root.nodeValue = tr;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const el = root as Element;
    if (el.nodeType === Node.ELEMENT_NODE && (SKIP.has(el.tagName) || el.closest?.("[data-no-i18n]"))) return;
    if (el.nodeType === Node.ELEMENT_NODE) {
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v) {
          const tr = t(v);
          if (tr !== v) el.setAttribute(a, tr);
        }
      }
    }
    for (const c of Array.from(root.childNodes)) translateNode(c);
  }

  /** Traduit un fragment HTML (tickets imprimés, qui ne passent pas par l'écran). */
  function html(src: string): string {
    if (LANG === "fr") return src;
    const tpl = document.createElement("template");
    tpl.innerHTML = src;
    translateNode(tpl.content);
    return tpl.innerHTML;
  }

  function start(): void {
    if (LANG === "fr") return;
    document.documentElement.lang = "nl";
    translateNode(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") translateNode(m.target);
        else if (m.type === "attributes") translateNode(m.target);
        else for (const n of Array.from(m.addedNodes)) translateNode(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  return { t, html, start };
})();

function setLang(lang: Lang): void {
  if (lang === LANG) return;
  try {
    localStorage.setItem("lang", lang);
  } catch {
    /* non mémorisé : choix valable jusqu'au redémarrage */
  }
  void window.api.call("app.reload");
}

/** Petit sélecteur FR | NL (écrans de connexion, d'activation et de premier démarrage). */
function langSwitch(): string {
  return `<div class="lang-switch" data-no-i18n role="group" aria-label="Langue / Taal">
    <button type="button" data-lang="fr" class="${LANG === "fr" ? "active" : ""}">FR</button>
    <button type="button" data-lang="nl" class="${LANG === "nl" ? "active" : ""}">NL</button>
  </div>`;
}

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest?.("[data-lang]") as HTMLElement | null;
  if (b) setLang(b.dataset.lang === "nl" ? "nl" : "fr");
});
document.addEventListener("DOMContentLoaded", () => i18n.start());
