/**
 * Serveur de vérification de licence pour Glory FCC Client — Cloudflare
 * Worker + Workers KV (stockage clé/valeur des licences).
 *
 * Routes :
 *   POST /verify              { key } -> { valid, reason?, expiresAt?, clientName? }
 *     Utilisée par le client Electron à chaque lancement (voir
 *     client/src/core/license/index.ts). Aucune authentification requise —
 *     la clé de licence elle-même EST le secret à vérifier.
 *
 *   POST   /admin/keys        { key, clientName, expiresAt } -> { ok }
 *   DELETE /admin/keys/:key   -> { ok }
 *     Réservées à l'administrateur (toi) : créer/révoquer une licence.
 *     Protégées par un jeton (variable d'environnement ADMIN_TOKEN, définie
 *     comme secret Cloudflare — voir README.md de ce dossier), à fournir
 *     dans l'en-tête `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 * Format d'un enregistrement de licence stocké dans KV (clé = la licence
 * elle-même, valeur = JSON) :
 *   { "clientName": "Nom du client", "expiresAt": "2027-01-01T00:00:00.000Z", "revoked": false }
 */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ valid: false, reason: "malformed_request" }, 400);
  }
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key) {
    return json({ valid: false, reason: "malformed_request" }, 400);
  }

  const record = await env.LICENSES.get(key, "json");
  if (!record) {
    return json({ valid: false, reason: "unknown_key" });
  }
  if (record.revoked) {
    return json({ valid: false, reason: "revoked" });
  }
  if (record.expiresAt && Date.now() > Date.parse(record.expiresAt)) {
    return json({ valid: false, reason: "expired", expiresAt: record.expiresAt });
  }
  return json({ valid: true, clientName: record.clientName ?? null, expiresAt: record.expiresAt ?? null });
}

async function handleAdminCreate(request, env) {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "malformed_request" }, 400);
  }
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const clientName = typeof body?.clientName === "string" ? body.clientName : null;
  const expiresAt = typeof body?.expiresAt === "string" ? body.expiresAt : null;
  if (!key || !expiresAt) {
    return json({ error: "key et expiresAt sont requis" }, 400);
  }
  await env.LICENSES.put(key, JSON.stringify({ clientName, expiresAt, revoked: false }));
  return json({ ok: true, key, clientName, expiresAt });
}

async function handleAdminDelete(request, env, key) {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  await env.LICENSES.delete(key);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env);
    }
    if (url.pathname === "/admin/keys" && request.method === "POST") {
      return handleAdminCreate(request, env);
    }
    if (url.pathname.startsWith("/admin/keys/") && request.method === "DELETE") {
      const key = decodeURIComponent(url.pathname.slice("/admin/keys/".length));
      return handleAdminDelete(request, env, key);
    }

    return json({ error: "not_found" }, 404);
  },
};
