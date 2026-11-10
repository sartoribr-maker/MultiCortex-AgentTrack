import "server-only";
import { randomUUID } from "node:crypto";
import { checkCrmAdmin, refreshCrmAccess, revokeCrmRefresh, type CrmLogin, type CrmPrincipal } from "./crm-auth";

/**
 * Server-side CRM sessions. The browser cookie carries only an opaque session id;
 * CRM access and refresh tokens stay in this process' memory. A restart of the
 * monitor ends all sessions (users sign in again), which is the safe failure mode.
 */
export const CRM_SESSION_MAX_AGE_S = 12 * 60 * 60;
const REFRESH_BEFORE_S = 90;        // renew the 15-min CRM access token ahead of expiry
// Role/status re-checked at the CRM at most every minute; a briefly unreachable CRM keeps a
// recently confirmed admin for 5 min. Both tunable (0 = check on every request, no grace).
const seconds = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : fallback * 1000;
};
const revalidateEveryMs = () => seconds("DEVCORE_CRM_REVALIDATE_SECONDS", 60);
const outageGraceMs = () => seconds("DEVCORE_CRM_OUTAGE_GRACE_SECONDS", 300);
const MAX_SESSIONS = 500;

type Entry = {
  userId: string; email: string; createdAt: number;
  accessToken: string; expiresAt: number; refreshToken: string | null;
  principal: CrmPrincipal; confirmedAt: number;
  pending?: Promise<boolean>;
};
export type CrmSessionResult = { status: "ok"; principal: CrmPrincipal } | { status: "expired" } | { status: "forbidden" };

const globalStore = globalThis as typeof globalThis & { __devcoreCrmSessions?: Map<string, Entry> };
const sessions = (globalStore.__devcoreCrmSessions ??= new Map<string, Entry>());

function purge(now: number) {
  for (const [id, entry] of sessions) {
    if (now - entry.createdAt > CRM_SESSION_MAX_AGE_S * 1000 || (!entry.refreshToken && entry.expiresAt * 1000 <= now)) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

export function createCrmSession(login: CrmLogin, now = Date.now()): string {
  purge(now);
  const id = randomUUID();
  sessions.set(id, {
    userId: login.id, email: login.email.toLowerCase(), createdAt: now,
    accessToken: login.accessToken, expiresAt: login.expiresAt, refreshToken: login.refreshToken,
    principal: { id: login.id, email: login.email.toLowerCase(), name: login.name, roleId: login.roleId }, confirmedAt: now,
  });
  return id;
}

export async function endCrmSession(id: unknown) {
  if (typeof id !== "string") return;
  const entry = sessions.get(id);
  sessions.delete(id);
  if (entry?.refreshToken) await revokeCrmRefresh(entry.refreshToken);
}

/** Renews the access token once even when several requests arrive together. */
function renew(entry: Entry): Promise<boolean> {
  entry.pending ??= (async () => {
    if (!entry.refreshToken) return false;
    const result = await refreshCrmAccess(entry.refreshToken, { id: entry.userId, email: entry.email });
    if (result === "unavailable") return entry.expiresAt * 1000 > Date.now();
    if (!result) return false;
    entry.accessToken = result.accessToken; entry.expiresAt = result.expiresAt; entry.refreshToken = result.refreshToken;
    return true;
  })().finally(() => { entry.pending = undefined; });
  return entry.pending;
}

export async function crmSessionAdmin(id: unknown, email: string, now = Date.now()): Promise<CrmSessionResult> {
  if (typeof id !== "string") return { status: "expired" };
  const entry = sessions.get(id);
  if (!entry || entry.email !== email.trim().toLowerCase() || now - entry.createdAt > CRM_SESSION_MAX_AGE_S * 1000) {
    sessions.delete(id);
    return { status: "expired" };
  }
  if (entry.expiresAt - now / 1000 < REFRESH_BEFORE_S && !(await renew(entry))) {
    sessions.delete(id);
    return { status: "expired" };
  }
  if (now - entry.confirmedAt < revalidateEveryMs()) return { status: "ok", principal: entry.principal };
  const check = await checkCrmAdmin(entry.accessToken, { id: entry.userId, email: entry.email });
  if (check.status === "ok") {
    entry.principal = check.principal; entry.confirmedAt = now;
    return { status: "ok", principal: check.principal };
  }
  if (check.status === "unavailable" && now - entry.confirmedAt < outageGraceMs()) return { status: "ok", principal: entry.principal };
  sessions.delete(id);
  return check.status === "denied" ? { status: "forbidden" } : { status: "expired" };
}

/** Test helper. */
export function resetCrmSessions() { sessions.clear(); }
