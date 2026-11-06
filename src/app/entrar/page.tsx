import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDevcoreAccess } from "@/lib/devcore/session";
import { BrandMark } from "@/components/devcore/brand";
import { DevcoreLoginForm } from "./login-form";
import { crmAuthEnabled } from "@/lib/devcore/crm-auth";

export const metadata: Metadata = { title: "Entrar" };

export default async function DevcoreLoginPage() {
  const access = await getDevcoreAccess();
  if (access.ok) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3 rounded-xl bg-[var(--dc-navy)] px-4 py-4 text-white">
          <BrandMark />
        </div>
        <div className="rounded-xl border border-[var(--dc-border)] bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-[var(--dc-navy)]">Acesso da equipe</h1>
          <p className="mb-5 mt-1 text-sm text-[var(--dc-text-muted)]">
            {access.ok === false && access.reason === "forbidden"
              ? crmAuthEnabled() ? "Sua sessão expirou ou sua conta não possui acesso ativo como Administrador no CRM. Entre novamente." : "Sua conta não tem perfil de equipe MultiCortex."
              : crmAuthEnabled() ? "Use seu e-mail e senha da Plataforma CRM. Acesso exclusivo ao perfil Administrador." : "Use o e-mail e a senha cadastrados para o painel."}
          </p>
          <DevcoreLoginForm />
        </div>
      </div>
    </main>
  );
}
