/**
 * Copie les fichiers statiques (HTML/CSS non compilés par tsc, WSDL requis
 * à l'exécution) vers dist/ après compilation TypeScript — exécuté par le
 * script "build" de package.json.
 */
const fs = require("fs");
const path = require("path");

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

copy("src/ui/index.html", "dist/ui/index.html");
copy("src/ui/license.html", "dist/ui/license.html");
copy("src/ui/styles.css", "dist/ui/styles.css");
copy("resources/BrueBoxService.wsdl", "dist/resources/BrueBoxService.wsdl");
