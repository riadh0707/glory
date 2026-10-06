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
for (const f of fs.readdirSync("src/ui/img")) copy(path.join("src/ui/img", f), path.join("dist/ui/img", f));
copy("resources/BrueBoxService.wsdl", "dist/resources/BrueBoxService.wsdl");
