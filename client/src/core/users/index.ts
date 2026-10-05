import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Comptes de l'application (vendeurs/administrateurs), indépendants des
 * utilisateurs SOAP du terminal. Le PIN n'est jamais stocké en clair :
 * scrypt + sel aléatoire par utilisateur, comparaison à temps constant.
 */
export type Role = "admin" | "vendeur";

export interface PublicUser {
  name: string;
  role: Role;
}

interface StoredUser extends PublicUser {
  salt: string;
  hash: string;
}

function file(dir: string): string {
  return path.join(dir, "users.json");
}

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 32).toString("hex");
}

function readAll(dir: string): StoredUser[] {
  try {
    const data = JSON.parse(fs.readFileSync(file(dir), "utf8")) as StoredUser[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(dir: string, users: StoredUser[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(users, null, 2), "utf8");
}

export function listUsers(dir: string): PublicUser[] {
  return readAll(dir).map(({ name, role }) => ({ name, role }));
}

export function validatePin(pin: string): string | null {
  return /^\d{4,8}$/.test(pin) ? null : "Le code PIN doit contenir 4 à 8 chiffres.";
}

/** Crée ou remplace un utilisateur. */
export function saveUser(dir: string, name: string, role: Role, pin: string): void {
  const clean = name.trim();
  if (!clean) throw new Error("Nom d'utilisateur requis.");
  const pinError = validatePin(pin);
  if (pinError) throw new Error(pinError);
  const salt = crypto.randomBytes(16).toString("hex");
  const users = readAll(dir).filter((u) => u.name.toLowerCase() !== clean.toLowerCase());
  users.push({ name: clean, role, salt, hash: hashPin(pin, salt) });
  writeAll(dir, users);
}

/** Refuse de supprimer le dernier administrateur (sinon plus aucun accès aux réglages). */
export function deleteUser(dir: string, name: string): void {
  const users = readAll(dir);
  const target = users.find((u) => u.name === name);
  if (!target) return;
  const admins = users.filter((u) => u.role === "admin");
  if (target.role === "admin" && admins.length <= 1) {
    throw new Error("Impossible de supprimer le dernier administrateur.");
  }
  writeAll(dir, users.filter((u) => u.name !== name));
}

export function verifyUser(dir: string, name: string, pin: string): PublicUser | null {
  const u = readAll(dir).find((x) => x.name === name);
  if (!u) return null;
  const a = Buffer.from(hashPin(pin, u.salt), "hex");
  const b = Buffer.from(u.hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { name: u.name, role: u.role };
}
