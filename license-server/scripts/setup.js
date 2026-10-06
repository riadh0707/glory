/**
 * Installation initiale (une seule fois) :
 *  1. génère la paire de clés Ed25519 de signature et le jeton admin ;
 *  2. les enregistre dans .admin.json (hors git — À SAUVEGARDER) ;
 *  3. envoie les secrets à Cloudflare (wrangler secret put) ;
 *  4. affiche la clé publique à intégrer dans le logiciel.
 *
 * Usage : node scripts/setup.js <url-du-worker>
 * Relancer avec --force régénère TOUT : les licences déjà activées devront
 * être réactivées et le logiciel recompilé avec la nouvelle clé publique.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(dir, ".admin.json");
const url = process.argv[2];
const force = process.argv.includes("--force");

let cfg;
if (existsSync(file) && !force) {
  cfg = JSON.parse(readFileSync(file, "utf8"));
  console.log("Secrets existants réutilisés (.admin.json).");
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  cfg = {
    url: "",
    adminToken: randomBytes(32).toString("base64url"),
    signingKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}
if (url) cfg.url = url.replace(/\/+$/, "");
writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });

for (const [name, value] of [["ADMIN_TOKEN", cfg.adminToken], ["SIGNING_KEY", cfg.signingKey]]) {
  execSync(`npx wrangler secret put ${name}`, { cwd: dir, input: value, stdio: ["pipe", "inherit", "inherit"] });
}
console.log("\nClé publique à intégrer dans le logiciel (client/src/core/license/config.ts) :\n" + cfg.publicKey);
console.log("\nSAUVEGARDEZ license-server/.admin.json en lieu sûr (clé USB, coffre) : sans lui, impossible de gérer les licences.");
