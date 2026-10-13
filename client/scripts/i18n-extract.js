/**
 * Extrait tous les textes français affichables du code (interface + messages
 * du cœur) vers scripts/i18n/fr-segments.json, pour la traduction.
 *
 * Chaque texte est découpé comme il apparaîtra à l'écran : par balises HTML
 * (un nœud texte par morceau), avec les parties variables `${…}` remplacées
 * par {0}, {1}… (traduites ensuite comme des modèles).
 *
 * Usage : node scripts/i18n-extract.js
 */
const ts = require(process.env.TS_API || "typescript"); // TypeScript 5 (API JavaScript) : TS_API=F:/glory/tools/tsapi/node_modules/typescript
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "src");
const FILES = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "scripts") walk(p);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) FILES.push(p);
  }
})(ROOT);

// Appels dont les chaînes ne s'affichent pas (sélecteurs, journaux, noms d'actions…).
const SKIP_CALLEES = /^(console\.\w+|this\.log|log|history\.record|this\.history\.record|require|\$|\$\$|document\.getElementById|document\.querySelector|document\.querySelectorAll|\w+\.querySelector|\w+\.querySelectorAll|\w+\.closest|\w+\.addEventListener|\w+\.removeEventListener|\w+\.classList\.\w+|\w+\.setAttribute|\w+\.getAttribute|\w+\.hasAttribute|window\.api\.call|ipcRenderer\.\w+|\w+\.dispatchEvent|action|edit|localStorage\.\w+|sessionStorage\.\w+|fs\.\w+|path\.\w+|execFileSync|createHash|\w+\.digest|\w+\.update|\w+\.split|\w+\.join|\w+\.startsWith|\w+\.endsWith|\w+\.includes|\w+\.replace|\w+\.padStart|new RegExp|net\.fetch|fetch|\w+\.prepare|\w+\.exec|\w+\.get|\w+\.set|\w+\.has|\w+\.delete|\w+\.toLocaleDateString|\w+\.toLocaleTimeString|\w+\.toLocaleString|Intl\.\w+|new Intl\.\w+|import)$/;

const ATTR_RE = /\b(placeholder|title|aria-label|alt)="([^"]*)"/g;
const segments = new Map(); // texte → fichiers

function interesting(s) {
  const t = s.replace(/\{\d+\}/g, "").trim();
  if (t.length < 2) return false;
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(t)) return false;
  if (/^[a-z0-9_.:/#?=&%-]+$/.test(t)) return false; // identifiants, classes, chemins
  if (/^(https?:|file:|data:|\/|\.\/|#)/.test(t)) return false;
  if (/[{};]\s*$/.test(t) && /[:;{]/.test(t) && !/\s[a-zà-ÿ]{3,}\s/.test(t)) return false; // CSS
  if (/^[a-z]+(-[a-z]+)*( [a-z]+(-[a-z]+)*)*$/.test(t) && !/[àâçéèêëîïôûùüÿœ]/.test(t) && t.split(" ").every((w) => w.includes("-") || w.length < 4)) return false; // listes de classes
  // Du français : accent, espace entre mots, ou mot capitalisé.
  return /[àâçéèêëîïôûùüÿœÀÂÇÉÈÊËÎÏÔÛÙÜŸŒ]/.test(t) || /[A-Za-zÀ-ÿ]+\s+[A-Za-zÀ-ÿ]+/.test(t) || /^[A-ZÀ-Ý][a-zà-ÿ]{2,}/.test(t);
}

function add(text, file) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!interesting(t)) return;
  if (!segments.has(t)) segments.set(t, new Set());
  segments.get(t).add(path.relative(ROOT, file).replace(/\\/g, "/"));
}

/** Découpe un texte (avec {n}) en morceaux visibles : texte entre balises + attributs visibles. */
function splitVisible(full, file) {
  for (const m of full.matchAll(ATTR_RE)) add(m[2], file);
  const noTags = full.replace(/<[^>]*>/g, "\u0001");
  for (const part of noTags.split("\u0001")) {
    if (!part.trim()) continue;
    add(part, file);
    // Une partie variable peut contenir du HTML : on ajoute aussi les morceaux fixes seuls.
    if (/\{\d+\}/.test(part)) for (const piece of part.split(/\{\d+\}/)) add(piece, file);
  }
}

function calleeText(node) {
  let p = node.parent;
  while (p && (ts.isBinaryExpression(p) || ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
  if (p && ts.isCallExpression(p) && p.arguments.includes(node.parent === p ? node : node)) return p.expression.getText();
  if (p && (ts.isCallExpression(p) || ts.isNewExpression(p))) return p.expression.getText();
  return "";
}

for (const file of FILES) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isElementAccessExpression(node)) return visit(node.expression);
    if (ts.isPropertyAssignment(node) && (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))) {
      // Clés d'objets : ignorées ; valeurs : visitées.
      visit(node.initializer);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const callee = calleeText(node);
      if (!SKIP_CALLEES.test(callee) && !ts.isLiteralTypeNode(node.parent) && !ts.isCaseClause(node.parent)) splitVisible(node.text, file);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const callee = calleeText(node);
      if (!SKIP_CALLEES.test(callee)) {
        let full = node.head.text;
        node.templateSpans.forEach((sp, i) => {
          full += `{${i}}` + sp.literal.text;
        });
        // Renumérote les {n} par morceau visible (chaque morceau commence à {0}).
        const noTags = full.replace(/<[^>]*>/g, (tag) => {
          for (const m of tag.matchAll(ATTR_RE)) add(m[2].replace(/\{\d+\}/g, "{0}"), file);
          return "\u0001";
        });
        for (const part of noTags.split("\u0001")) {
          if (!part.trim()) continue;
          let k = 0;
          const renum = part.replace(/\{\d+\}/g, () => `{${k++}}`);
          add(renum, file);
          if (k) for (const piece of part.split(/\{\d+\}/)) add(piece, file);
        }
      }
      node.templateSpans.forEach((sp) => visit(sp.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const out = [...segments.entries()].map(([fr, files]) => ({ fr, files: [...files] })).sort((a, b) => a.fr.localeCompare(b.fr, "fr"));
fs.mkdirSync(path.join(__dirname, "i18n"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "i18n", "fr-segments.json"), JSON.stringify(out, null, 1));
console.log(`${out.length} textes extraits de ${FILES.length} fichiers`);
