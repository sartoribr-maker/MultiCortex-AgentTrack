import "server-only";
import { auth } from "@/lib/auth";
import { findDevcoreUser } from "./users";
import { cache } from "react";
import { crmAuthEnabled } from "./crm-auth";
import { currentCrmAdmin } from "./crm-session";

export type DevcoreAccess =
  | { ok: true; user: { id: string; name: string | null; email: string } }
  | { ok: false; reason: "anonymous" | "expired" | "forbidden" };

/**
 * CRM mode revalidates the active Admin profile on each request.
 * Local mode keeps the legacy membership check; there is no CRM-to-local fallback.
 */
export const getDevcoreAccess = cache(async (): Promise<DevcoreAccess> => {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { ok: false, reason: "anonymous" };
  if (crmAuthEnabled()) {
    const result = await currentCrmAdmin(email);
    if (result.status !== "ok") return { ok: false, reason: result.status };
    const user = result.principal;
    return { ok: true, user: { id: user.id, name: user.name, email: user.email } };
  }
  const user = findDevcoreUser(email);
  if (!user) return { ok: false, reason: "forbidden" };
  return { ok: true, user: { id: user.email, name: user.name ?? session.user?.name ?? null, email: user.email } };
});
