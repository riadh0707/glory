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
 *   GET    /admin/reports               rapports d'assistance reçus
 *   GET    /admin/reports/:id           télécharge un rapport (Markdown)
 *   DELETE /admin/reports/:id           supprime un rapport
 *
 * Route du logiciel pour les rapports : POST /reports { key, machineId, version, gzip }
 * (PC activé uniquement, conservés 90 jours).
 *
 * Secrets Cloudflare : ADMIN_TOKEN, SIGNING_KEY (clé privée Ed25519, PKCS#8 en base64).
 */

/**
 * Licences « en ligne » (offline: false) : durée pendant laquelle le logiciel
 * fonctionne sans joindre le serveur. Les licences « hors ligne » (par défaut)
 * fonctionnent sans limite après la première activation (refreshBy: null).
 */
const OFFLINE_GRACE_DAYS = 14;

import ADMIN_HTML from "./admin.html";
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
    refreshBy: rec.offline === false ? new Date(issuedAt + OFFLINE_GRACE_DAYS * 86400_000).toISOString() : null,
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
    const rec = { client: String(body.client || "").slice(0, 120), note: String(body.note || "").slice(0, 500), createdAt: new Date().toISOString(), expiresAt, seats, revoked: false, offline: body.offline !== false, machines: [] };
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
    if ("offline" in body) rec.offline = !!body.offline;
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

// ------------------------------------------------------------ rapports d'assistance
//
// Le logiciel envoie son rapport (Markdown compressé gzip, en base64) :
//   POST /reports { key, machineId, version, gzip }
// Seul un PC activé sur une licence existante peut envoyer (clé + identifiant
// du PC). Stockage KV « rep:<horodatage inversé>:<id> », conservé 90 jours.
const REPORT_MAX_BYTES = 6 * 1024 * 1024; // compressé
const REPORT_TTL = 90 * 86400;

async function handleReportUpload(request, env) {
  const body = await readBody(request);
  const key = normalizeKey(body?.key);
  const machineId = typeof body?.machineId === "string" ? body.machineId.slice(0, 64) : "";
  const gzip = typeof body?.gzip === "string" ? body.gzip : "";
  if (!key || !machineId || !gzip || !/^[A-Za-z0-9+/=]+$/.test(gzip)) return json({ ok: false, message: "Requête invalide." }, 400);
  if (gzip.length * 0.75 > REPORT_MAX_BYTES) return json({ ok: false, message: "Rapport trop volumineux." }, 413);
  const rec = await getLicense(env, key);
  const m = rec?.machines?.find((x) => x.id === machineId);
  if (!rec || !m) return json({ ok: false, message: "PC non activé : rapport refusé." }, 403);
  const now = Date.now();
  // Clé triée du plus récent au plus ancien (KV liste par ordre alphabétique).
  const id = `${String(9999999999999 - now).padStart(13, "0")}-${crypto.randomUUID().slice(0, 8)}`;
  const meta = {
    ts: new Date(now).toISOString(),
    client: rec.client || "",
    key,
    machine: m.name || machineId,
    machineId,
    version: String(body.version || "").slice(0, 20),
    size: Math.round(gzip.length * 0.75),
    note: String(body.note || "").slice(0, 300),
  };
  await env.LICENSES.put(`rep:${id}`, gzip, { expirationTtl: REPORT_TTL, metadata: meta });
  return json({ ok: true, id });
}

async function handleAdminReports(request, env, url) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const parts = url.pathname.split("/").filter(Boolean); // ["admin","reports",id?]
  const id = parts[2] ? decodeURIComponent(parts[2]).replace(/[^0-9a-f-]/gi, "") : "";
  if (!id && request.method === "GET") {
    const out = [];
    let cursor;
    do {
      const page = await env.LICENSES.list({ prefix: "rep:", cursor });
      for (const k of page.keys) out.push({ id: k.name.slice(4), ...(k.metadata || {}) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && out.length < 2000);
    return json({ ok: true, reports: out });
  }
  if (id && request.method === "GET") {
    const v = await env.LICENSES.getWithMetadata(`rep:${id}`, "text");
    if (!v.value) return json({ error: "rapport introuvable" }, 404);
    // Décompression côté serveur : le navigateur reçoit le texte du rapport.
    const bin = Uint8Array.from(atob(v.value), (c) => c.charCodeAt(0));
    const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const meta = v.metadata || {};
    const name = `rapport_${String(meta.client || "client").replace(/[^A-Za-z0-9_-]+/g, "_")}_${String(meta.ts || "").slice(0, 19).replace(/[:T]/g, "-")}.md`;
    return new Response(text, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
    });
  }
  if (id && request.method === "DELETE") {
    await env.LICENSES.delete(`rep:${id}`);
    return json({ ok: true });
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
      if (request.method === "POST" && url.pathname === "/reports") return await handleReportUpload(request, env);
      if (url.pathname.startsWith("/admin/reports")) return await handleAdminReports(request, env, url);
      if (url.pathname === "/") return json({ ok: true, service: "glory-fcc-licenses" });
      if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
        // Page d'administration : le jeton est saisi dans la page, jamais dans l'URL.
        return new Response(ADMIN_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ ok: false, reason: "server_error", message: "Erreur du serveur de licences." }, 500);
    }
  },
};
