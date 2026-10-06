/**
 * Gestion des licences en ligne de commande.
 *
 *   node scripts/licences.js liste
 *   node scripts/licences.js creer "Nom du client" [--expire 2027-12-31] [--postes 1] [--note "..."]
 *   node scripts/licences.js voir     GFCC-XXXXX-...
 *   node scripts/licences.js desactiver GFCC-...      (bloque le logiciel au prochain contrôle)
 *   node scripts/licences.js reactiver  GFCC-...
 *   node scripts/licences.js prolonger  GFCC-... 2028-12-31   (ou « jamais » = définitive)
 *   node scripts/licences.js postes     GFCC-... 2
 *   node scripts/licences.js transferer GFCC-...      (délie les PC : le client peut activer un nouveau PC)
 *   node scripts/licences.js supprimer  GFCC-...
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(path.join(dir, ".admin.json"), "utf8"));
const [cmd, ...rest] = process.argv.slice(2);

function opt(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function api(method, p, body) {
  const r = await fetch(cfg.url + p, {
    method,
    headers: { Authorization: `Bearer ${cfg.adminToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-BE") : "définitive");

function show(l) {
  const state = l.revoked ? "DÉSACTIVÉE" : l.expiresAt && Date.parse(l.expiresAt) < Date.now() ? "EXPIRÉE" : "active";
  console.log(`${l.key}  ${state}`);
  console.log(`  Client   : ${l.client || "-"}${l.note ? `  (${l.note})` : ""}`);
  console.log(`  Fin      : ${day(l.expiresAt)}`);
  console.log(`  PC       : ${(l.machines || []).length}/${l.seats || 1}`);
  for (const m of l.machines || []) console.log(`    - ${m.name || "?"} [${m.id}] activé le ${day(m.firstAt)}, vu le ${new Date(m.lastAt).toLocaleString("fr-BE")}${m.version ? `, v${m.version}` : ""}`);
}

const key = rest[0];
try {
  switch (cmd) {
    case "liste": {
      const { licenses } = await api("GET", "/admin/keys");
      if (!licenses.length) console.log("Aucune licence.");
      for (const l of licenses) show(l);
      break;
    }
    case "creer": {
      if (!rest[0] || rest[0].startsWith("--")) throw new Error('Nom du client manquant : creer "Nom du client"');
      const l = await api("POST", "/admin/keys", { client: rest[0], expiresAt: opt("expire") ?? null, seats: opt("postes") ?? 1, note: opt("note") ?? "" });
      console.log("Licence créée — clé à donner au client :\n");
      show(l);
      break;
    }
    case "voir":
      show(await api("GET", `/admin/keys/${key}`));
      break;
    case "desactiver":
      show(await api("PATCH", `/admin/keys/${key}`, { revoked: true }));
      break;
    case "reactiver":
      show(await api("PATCH", `/admin/keys/${key}`, { revoked: false }));
      break;
    case "prolonger":
      show(await api("PATCH", `/admin/keys/${key}`, { expiresAt: rest[1] === "jamais" ? null : rest[1] }));
      break;
    case "postes":
      show(await api("PATCH", `/admin/keys/${key}`, { seats: Number(rest[1]) }));
      break;
    case "transferer":
      show(await api("POST", `/admin/keys/${key}/reset`));
      break;
    case "supprimer":
      await api("DELETE", `/admin/keys/${key}`);
      console.log("Supprimée.");
      break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  }
} catch (e) {
  console.error("Erreur :", e.message);
  process.exitCode = 1;
}
