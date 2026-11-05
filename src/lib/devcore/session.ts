import "server-only";
import { auth } from "@/lib/auth";
import { findDevcoreUser } from "./users";

export type DevcoreAccess =
  | { ok: true; user: { id: string; name: string | null; email: string } }
  | { ok: false; reason: "anonymous" | "forbidden" };

/**
 * Dashboard access: a logged-in member of DEVCORE_USERS. A valid session whose
 * e-mail was removed from DEVCORE_USERS is "forbidden" (access revoked).
 */
export async function getDevcoreAccess(): Promise<DevcoreAccess> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { ok: false, reason: "anonymous" };
  const user = findDevcoreUser(email);
  if (!user) return { ok: false, reason: "forbidden" };
  return { ok: true, user: { id: user.email, name: user.name ?? session.user?.name ?? null, email: user.email } };
}
