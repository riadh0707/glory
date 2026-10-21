/**
 * Publie une version de MedaCash dans le dépôt public des mises à jour
 * (riadh0707/medacash-updates) : installateur Windows, son .blockmap et
 * latest.yml. Le logiciel installé les trouve tout seul.
 *
 *   node scripts/publish-update.mjs v1.14.0            (depuis la construction GitHub Actions du tag)
 *   node scripts/publish-update.mjs v1.14.0 --local    (depuis client/release/, construit sur ce PC)
 *
 * Jeton : celui de Git sur ce PC (gestionnaire d'identifiants), ou GH_TOKEN.
 * Aucun code source n'est envoyé dans le dépôt public.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE = "riadh0707/glory";
const PUBLIC = "riadh0707/medacash-updates";
const tag = process.argv[2];
const local = process.argv.includes("--local");
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  console.error("Usage : node scripts/publish-update.mjs v1.14.0 [--local]");
  process.exit(1);
}
const version = tag.slice(1);
const token =
  process.env.GH_TOKEN ||
  execSync("git credential fill", { input: "protocol=https\nhost=github.com\n\n" }).toString().match(/^password=(.*)$/m)[1].trim();

async function gh(method, url, body, headers = {}) {
  const r = await fetch(url.startsWith("http") ? url : "https://api.github.com" + url, {
    method,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", ...headers },
    body,
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${await r.text()}`);
  return r;
}

// 1. Récupère les fichiers.
let dir;
if (local) {
  dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "release");
} else {
  const runs = await (await gh("GET", `/repos/${PRIVATE}/actions/runs?head_branch=${tag}&per_page=5`)).json();
  const run = runs.workflow_runs.find((r) => r.conclusion === "success");
  if (!run) throw new Error(`Aucune construction réussie pour ${tag}.`);
  const arts = await (await gh("GET", `/repos/${PRIVATE}/actions/runs/${run.id}/artifacts`)).json();
  const win = arts.artifacts.find((a) => a.name === "glory-fcc-client-windows");
  if (!win) throw new Error("Artefact Windows introuvable.");
  dir = mkdtempSync(path.join(tmpdir(), "medacash-"));
  const zip = path.join(dir, "windows.zip");
  writeFileSync(zip, Buffer.from(await (await gh("GET", win.archive_download_url)).arrayBuffer()));
  execSync(`tar -xf "${zip}" -C "${dir}"`);
}
const exe = `MedaCash-Setup-${version}.exe`;
const files = [exe, `${exe}.blockmap`, "latest.yml"].map((f) => path.join(dir, f));
for (const f of files) if (!existsSync(f)) throw new Error(`Fichier manquant : ${f}`);
if (!readFileSync(files[2], "utf8").includes(`version: ${version}`)) throw new Error("latest.yml ne correspond pas à cette version.");

// 2. Crée (ou remplace) la release publique.
const existing = await fetch(`https://api.github.com/repos/${PUBLIC}/releases/tags/${tag}`, { headers: { Authorization: "Bearer " + token } });
if (existing.ok) {
  const rel = await existing.json();
  await gh("DELETE", `/repos/${PUBLIC}/releases/${rel.id}`);
  await fetch(`https://api.github.com/repos/${PUBLIC}/git/refs/tags/${tag}`, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  console.log(`Ancienne release ${tag} remplacée.`);
}
const rel = await (
  await gh(
    "POST",
    `/repos/${PUBLIC}/releases`,
    JSON.stringify({ tag_name: tag, name: `MedaCash ${version}`, body: `Mise à jour automatique de MedaCash ${version}.`, draft: false, prerelease: false }),
    { "Content-Type": "application/json" }
  )
).json();
const uploadBase = rel.upload_url.replace(/\{.*$/, "");
for (const f of files) {
  const name = path.basename(f);
  process.stdout.write(`Envoi de ${name} (${(statSync(f).size / 1048576).toFixed(1)} Mo)… `);
  await gh("POST", `${uploadBase}?name=${encodeURIComponent(name)}`, readFileSync(f), { "Content-Type": "application/octet-stream" });
  console.log("ok");
}
console.log(`Publié : ${rel.html_url}`);
