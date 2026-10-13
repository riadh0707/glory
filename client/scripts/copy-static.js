/**
 * Copie les fichiers statiques (HTML/CSS non compilés par tsc, WSDL requis
 * à l'exécution) vers dist/ après compilation TypeScript.
 */
const fs = require("fs");
const path = require("path");

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

copy("src/ui/index.html", "dist/ui/index.html");
copy("src/ui/styles.css", "dist/ui/styles.css");
copy("src/ui/receipt.css", "dist/ui/receipt.css");
// Dictionnaire néerlandais, chargé comme script (pas de fetch de fichier local).
fs.writeFileSync("dist/ui/i18n-nl.js", "var I18N_NL = " + fs.readFileSync("scripts/i18n/nl.json", "utf8") + ";\n");
for (const f of fs.readdirSync("src/ui/img")) copy(path.join("src/ui/img", f), path.join("dist/ui/img", f));
copy("resources/BrueBoxService.wsdl", "dist/resources/BrueBoxService.wsdl");
