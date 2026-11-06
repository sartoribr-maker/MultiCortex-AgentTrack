import { authorizeDevcoreAdmin } from "@/lib/devcore/admin";
import { getDevcoreAccess } from "@/lib/devcore/session";
import { BrandMark } from "./brand";
import { devcoreLogoutAction } from "@/app/actions";
import { PocWorkspace } from "./poc-workspace";
export async function PocShell({ pocId }: { pocId?: string }) {
  const access = await getDevcoreAccess();
  const denied = await authorizeDevcoreAdmin();
  return <><header className="border-b-4 border-[var(--dc-orange)] bg-[var(--dc-navy)] text-white"><div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8"><BrandMark /><form action={devcoreLogoutAction} className="flex items-center gap-4 text-sm"><span className="hidden sm:inline">{access.ok ? access.user.name || access.user.email : ""}</span><button className="rounded-lg border border-white/30 px-3 py-1.5 font-bold">Sair</button></form></div></header><main>{denied ? <div className="mx-auto max-w-7xl p-8"><h1 className="text-2xl font-bold">Acesso administrativo necessário</h1><p className="mt-3">Seu usuário não está autorizado a administrar POCs e PODs.</p></div> : <PocWorkspace pocId={pocId} />}</main></>;
}
