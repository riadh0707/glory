/**
 * Serveur de licences Glory FCC Client — Cloudflare Worker + Workers KV.
 *
 * Une licence (clé de produit) est stockée dans KV sous « lic:<CLÉ> » :
 *   { client, note, createdAt, expiresAt|null, seats, revoked, machines: [{ id, name, firstAt, lastAt, version }] }
 *
 * Routes publiques (appelées par le logiciel) :
 *   POST /activate { key, machineId, machineName, version }
 *     Lie la clé à ce PC (dans la limite de « seats ») et renvoie un jeton
 *     signé (Ed25519). Le logiciel vérifie la signature avec la clé publique
 *     intégrée : un jeton fabriqué ou modifié est rejeté.
 *   POST /refresh  { key, machineId, version }
 *     Renouvelle le jeton d'un PC déjà activé (n'ajoute jamais de PC).
 *
 * Routes d'administration (en-tête Authorization: Bearer <ADMIN_TOKEN>) :
 *   GET    /admin/keys                  liste
 *   POST   /admin/keys                  { client, expiresAt?, seats?, note? } → crée une clé
 *   GET    /admin/keys/:key             détail
 *   PATCH  /admin/keys/:key             { client?, expiresAt?, seats?, note?, revoked? }
 *   POST   /admin/keys/:key/reset       délie tous les PC (transfert vers un nouveau PC)
 *   DELETE /admin/keys/:key             supprime
 *
 * Secrets Cloudflare : ADMIN_TOKEN, SIGNING_KEY (clé privée Ed25519, PKCS#8 en base64).
 */

/** Durée pendant laquelle le logiciel fonctionne sans joindre le serveur. */
const OFFLINE_GRACE_DAYS = 14;
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function normalizeKey(k) {
  return typeof k === "string" ? k.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") : "";
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join("");
  return `GFCC-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}`;
}

async function signToken(env, payload) {
  const key = await crypto.subtle.importKey("pkcs8", fromB64(env.SIGNING_KEY), { name: "Ed25519" }, false, ["sign"]);
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getLicense(env, key) {
  return key ? env.LICENSES.get(`lic:${key}`, "json") : null;
}

async function putLicense(env, key, rec) {
  await env.LICENSES.put(`lic:${key}`, JSON.stringify(rec));
}

/** Refus communs à /activate et /refresh. */
function refusal(rec) {
  if (!rec) return { reason: "unknown_key", message: "Clé de produit inconnue." };
  if (rec.revoked) return { reason: "revoked", message: "Cette licence a été désactivée. Contactez votre fournisseur." };
  if (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt)) return { reason: "expired", message: "Cette licence a expiré. Contactez votre fournisseur pour la renouveler." };
  return null;
}

async function handleClient(request, env, mode) {
  const body = await readBody(request);
  const key = normalizeKey(body?.key);
  const machineId = typeof body?.machineId === "string" ? body.machineId.slice(0, 64) : "";
  if (!key || !/^[A-Za-z0-9-]{8,64}$/.test(machineId)) return json({ ok: false, reason: "malformed", message: "Requête invalide." }, 400);
  const rec = await getLicense(env, key);
  const refused = refusal(rec);
  if (refused) return json({ ok: false, ...refused });

  const now = new Date().toISOString();
  rec.machines = Array.isArray(rec.machines) ? rec.machines : [];
  let m = rec.machines.find((x) => x.id === machineId);
  if (!m) {
    if (mode === "refresh") return json({ ok: false, reason: "not_activated", message: "Ce PC n'est plus activé pour cette licence." });
    if (rec.machines.length >= (rec.seats || 1)) {
      return json({ ok: false, reason: "seats_full", message: "Cette clé est déjà utilisée sur un autre PC. Contactez votre fournisseur pour la transférer." });
    }
    m = { id: machineId, name: "", firstAt: now };
    rec.machines.push(m);
  }
  m.lastAt = now;
  if (typeof body.machineName === "string") m.name = body.machineName.slice(0, 80);
  if (typeof body.version === "string") m.version = body.version.slice(0, 20);
  await putLicense(env, key, rec);

  const issuedAt = Date.now();
  const token = await signToken(env, {
    v: 1,
    key,
    client: rec.client || "",
    machineId,
    expiresAt: rec.expiresAt || null,
    issuedAt: new Date(issuedAt).toISOString(),
    refreshBy: new Date(issuedAt + OFFLINE_GRACE_DAYS * 86400_000).toISOString(),
  });
  return json({ ok: true, token, client: rec.client || "", expiresAt: rec.expiresAt || null });
}

// ------------------------------------------------------------------ admin

function authorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return false;
  // Comparaison à temps constant.
  const a = new TextEncoder().encode(auth);
  const b = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function cleanExpiry(v) {
  if (v === null || v === "" || v === undefined) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

async function handleAdmin(request, env, url) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const parts = url.pathname.split("/").filter(Boolean); // ["admin","keys",key?,action?]
  const key = parts[2] ? normalizeKey(decodeURIComponent(parts[2])) : "";
  const action = parts[3] || "";

  if (!key && request.method === "GET") {
    const out = [];
    let cursor;
    do {
      const page = await env.LICENSES.list({ prefix: "lic:", cursor });
      for (const k of page.keys) out.push({ key: k.name.slice(4), ...(await env.LICENSES.get(k.name, "json")) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ ok: true, licenses: out });
  }

  if (!key && request.method === "POST") {
    const body = (await readBody(request)) || {};
    const expiresAt = cleanExpiry(body.expiresAt);
    if (expiresAt === undefined) return json({ error: "date d'expiration invalide" }, 400);
    const seats = Math.max(1, Math.min(50, Math.round(Number(body.seats) || 1)));
    let k = newKey();
    while (await getLicense(env, k)) k = newKey();
    const rec = { client: String(body.client || "").slice(0, 120), note: String(body.note || "").slice(0, 500), createdAt: new Date().toISOString(), expiresAt, seats, revoked: false, machines: [] };
    await putLicense(env, k, rec);
    return json({ ok: true, key: k, ...rec });
  }

  const rec = await getLicense(env, key);
  if (!rec) return json({ error: "clé inconnue" }, 404);

  if (request.method === "GET" && !action) return json({ ok: true, key, ...rec });
  if (request.method === "DELETE" && !action) {
    await env.LICENSES.delete(`lic:${key}`);
    return json({ ok: true });
  }
  if (request.method === "POST" && action === "reset") {
    rec.machines = [];
    await putLicense(env, key, rec);
    return json({ ok: true, key, ...rec });
  }
  if (request.method === "PATCH" && !action) {
    const body = (await readBody(request)) || {};
    if ("client" in body) rec.client = String(body.client || "").slice(0, 120);
    if ("note" in body) rec.note = String(body.note || "").slice(0, 500);
    if ("seats" in body) rec.seats = Math.max(1, Math.min(50, Math.round(Number(body.seats) || 1)));
    if ("revoked" in body) rec.revoked = !!body.revoked;
    if ("expiresAt" in body) {
      const e = cleanExpiry(body.expiresAt);
      if (e === undefined) return json({ error: "date d'expiration invalide" }, 400);
      rec.expiresAt = e;
    }
    await putLicense(env, key, rec);
    return json({ ok: true, key, ...rec });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/activate") return await handleClient(request, env, "activate");
      if (request.method === "POST" && url.pathname === "/refresh") return await handleClient(request, env, "refresh");
      if (url.pathname.startsWith("/admin/keys")) return await handleAdmin(request, env, url);
      if (url.pathname === "/") return json({ ok: true, service: "glory-fcc-licenses" });
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ ok: false, reason: "server_error", message: "Erreur du serveur de licences." }, 500);
    }
  },
};
