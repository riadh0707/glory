#!/usr/bin/env node
/**
 * Révoque (supprime) une clé de licence existante.
 *
 * Usage :
 *   WORKER_URL=https://glory-fcc-license-server.<compte>.workers.dev \
 *   ADMIN_TOKEN=<jeton admin> \
 *   node scripts/revoke-key.js GLORY-XXXX-XXXX-XXXX-XXXX
 */
async function main() {
  const [key] = process.argv.slice(2);
  const workerUrl = process.env.WORKER_URL;
  const adminToken = process.env.ADMIN_TOKEN;

  if (!key) {
    console.error("Usage: node scripts/revoke-key.js GLORY-XXXX-XXXX-XXXX-XXXX");
    process.exit(1);
  }
  if (!workerUrl || !adminToken) {
    console.error("WORKER_URL et ADMIN_TOKEN doivent être définis (variables d'environnement).");
    process.exit(1);
  }

  const res = await fetch(`${workerUrl.replace(/\/$/, "")}/admin/keys/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!res.ok) {
    console.error(`Échec (${res.status}) :`, await res.text());
    process.exit(1);
  }
  console.log(`Clé révoquée : ${key}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
