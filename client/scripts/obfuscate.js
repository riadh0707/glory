/**
 * Obscurcit le JavaScript compilé (dist/) avant l'empaquetage de
 * l'installateur : le code livré devient très difficile à lire et à
 * modifier. Utilisé uniquement par les commandes dist:* (pas en développement).
 *
 * Les scripts de l'interface (dist/ui) sont des scripts globaux qui
 * s'appellent entre eux : leurs noms globaux sont conservés
 * (renameGlobals: false), seuls l'intérieur des fonctions et les chaînes
 * sont transformés.
 */
const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const OPTIONS = {
  target: "node",
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: false,
  numbersToExpressions: true,
  simplify: true,
  transformObjectKeys: false,
  selfDefending: false,
  sourceMap: false,
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
    else if (e.name.endsWith(".js.map")) fs.rmSync(p);
  }
  return out;
}

const files = walk(path.join(__dirname, "..", "dist"));
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const target = f.includes(`${path.sep}ui${path.sep}`) ? "browser" : "node";
  const code = JavaScriptObfuscator.obfuscate(src, { ...OPTIONS, target }).getObfuscatedCode();
  fs.writeFileSync(f, code);
}
console.log(`obfuscate : ${files.length} fichiers traités`);
