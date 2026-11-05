import bcrypt from "bcryptjs";

/**
 * Team members allowed into the dashboard, defined only on the server.
 *
 * DEVCORE_USERS = "email:hash[:Nome],email:hash[:Nome]"
 *
 * `hash` is a bcrypt hash, preferably base64-encoded (what scripts/hash-password.ts
 * prints): a raw bcrypt hash has "$" characters, which .env loaders and Compose
 * try to expand. A raw "$2…" hash is still accepted.
 */
export type DevcoreUser = { email: string; name: string | null; hash: string };

const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const EMAIL = /^[^\s@:,]+@[^\s@:,]+\.[^\s@:,]+$/;

/** Comparing against this keeps unknown e-mails as slow as wrong passwords. */
const DUMMY_HASH = "$2b$12$RhsGoxdv0LfsH3xlutrGZOgqCpoTE4bBX3no0z.5VqsztofA8Rg8C";

export function decodeHash(value: string): string {
  if (value.startsWith("$2")) return value;
  return Buffer.from(value, "base64").toString("utf8");
}

export function encodeHash(hash: string): string {
  return Buffer.from(hash, "utf8").toString("base64");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Parses DEVCORE_USERS. Errors name the entry position, never its content. */
export function parseDevcoreUsers(raw: string | undefined): DevcoreUser[] {
  const users: DevcoreUser[] = [];
  const seen = new Set<string>();
  const entries = (raw ?? "").split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  entries.forEach((entry, index) => {
    const [emailPart, hashPart, ...nameParts] = entry.split(":");
    const email = normalizeEmail(emailPart ?? "");
    const hash = decodeHash((hashPart ?? "").trim());
    const name = nameParts.join(":").trim() || null;
    if (!EMAIL.test(email) || !BCRYPT.test(hash)) {
      throw new Error(`DEVCORE_USERS: a entrada ${index + 1} é inválida (use email:hash[:Nome]).`);
    }
    if (seen.has(email)) throw new Error(`DEVCORE_USERS: a entrada ${index + 1} repete um e-mail.`);
    seen.add(email);
    users.push({ email, name, hash });
  });
  return users;
}

let cached: { raw: string | undefined; users: DevcoreUser[] } | null = null;

export function listDevcoreUsers(): DevcoreUser[] {
  const raw = process.env.DEVCORE_USERS;
  if (!cached || cached.raw !== raw) cached = { raw, users: parseDevcoreUsers(raw) };
  return cached.users;
}

export function findDevcoreUser(email: string | null | undefined): DevcoreUser | undefined {
  if (!email) return undefined;
  const wanted = normalizeEmail(email);
  return listDevcoreUsers().find((user) => user.email === wanted);
}

/** Checks e-mail and password. Same cost for unknown e-mail and wrong password. */
export async function verifyDevcoreUser(email: string, password: string): Promise<DevcoreUser | null> {
  const user = findDevcoreUser(email);
  const valid = await bcrypt.compare(password, user?.hash ?? DUMMY_HASH);
  return user && valid ? user : null;
}
