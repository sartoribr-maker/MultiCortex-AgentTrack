"use server";

import { authRedirect } from "@/lib/auth-redirect";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { crmAuthEnabled } from "@/lib/devcore/crm-auth";

export type DevcoreLoginState = { ok: boolean; message?: string; email?: string } | null;

export async function devcoreLoginAction(_prev: DevcoreLoginState, formData: FormData): Promise<DevcoreLoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { ok: false, message: "Informe e-mail e senha.", email };
  try {
    // redirect:false — the Server Action redirects below; the session cookie
    // is set on this host either way.
    await signIn("credentials", { email, password, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, message: crmAuthEnabled() ? "Acesso não autorizado. Confira suas credenciais e seu perfil Administrador no CRM. Se houver troca de senha obrigatória, conclua-a no CRM." : "E-mail ou senha inválidos.", email };
    throw error;
  }
  redirect(authRedirect("/"));
}

export async function devcoreLogoutAction() {
  await signOut({ redirect: false });
  redirect(authRedirect("/entrar"));
}
