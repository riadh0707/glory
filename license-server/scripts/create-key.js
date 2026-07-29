#!/usr/bin/env node
/**
 * Crée une nouvelle clé de licence côté serveur (Cloudflare Worker).
 *
 * Usage :
 *   WORKER_URL=https://glory-fcc-license-server.<compte>.workers.dev \
 *   ADMIN_TOKEN=<jeton admin> \
 *   node scripts/create-key.js "Nom du client" 2027-01-01
 *
 * Le 3e argument (date d'expiration) accepte n'importe quel format que
 * `Date()` sait parser (ex. 2027-01-01, "2027-01-01T00:00:00Z").
 */
const crypto = require("crypto");

function generateKey() {
  // Format lisible GLORY-XXXX-XXXX-XXXX-XXXX (groupes hexadécimaux courts).
  const bytes = crypto.randomBytes(10).toString("hex").toUpperCase();
  const groups = bytes.match(/.{1,4}/g);
  return `GLORY-${groups.join("-")}`;
}

async function main() {
  const [clientName, expiresAtRaw] = process.argv.slice(2);
  const workerUrl = process.env.WORKER_URL;
  const adminToken = process.env.ADMIN_TOKEN;

  if (!clientName || !expiresAtRaw) {
    console.error('Usage: node scripts/create-key.js "Nom du client" 2027-01-01');
    process.exit(1);
  }
  if (!workerUrl || !adminToken) {
    console.error("WORKER_URL et ADMIN_TOKEN doivent être définis (variables d'environnement).");
    process.exit(1);
  }

  const expiresAtDate = new Date(expiresAtRaw);
  if (Number.isNaN(expiresAtDate.getTime())) {
    console.error(`Date d'expiration invalide : "${expiresAtRaw}"`);
    process.exit(1);
  }

  const key = generateKey();
  const res = await fetch(`${workerUrl.replace(/\/$/, "")}/admin/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ key, clientName, expiresAt: expiresAtDate.toISOString() }),
  });

  if (!res.ok) {
    console.error(`Échec (${res.status}) :`, await res.text());
    process.exit(1);
  }

  const result = await res.json();
  console.log("Clé créée avec succès :");
  console.log(`  Clé          : ${result.key}`);
  console.log(`  Client       : ${result.clientName}`);
  console.log(`  Expire le    : ${result.expiresAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
