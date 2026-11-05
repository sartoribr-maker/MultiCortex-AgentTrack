import { redirect } from "next/navigation";
import { getDevcoreAccess } from "@/lib/devcore/session";
import { findDevcoreVm, listDevcoreVms, toPublicVm } from "@/lib/devcore/registry";
import { getDevcoreMetrics } from "@/lib/devcore/metrics";
import { getDevcoreLive } from "@/lib/devcore/live";
import { BrandMark } from "@/components/devcore/brand";
import { DevcoreDashboard } from "@/components/devcore/dashboard";
import { devcoreLogoutAction } from "./actions";

export default async function DevcorePage({ searchParams }: PageProps<"/">) {
  const access = await getDevcoreAccess();
  if (!access.ok) redirect("/entrar");

  const vms = listDevcoreVms();
  const { vm: requested } = await searchParams;
  const selected = findDevcoreVm(typeof requested === "string" ? requested : undefined) ?? vms[0];
  const initial = selected ? await getDevcoreMetrics(selected) : null;
  const initialLive = selected ? getDevcoreLive(selected) : null;

  return (
    <>
      <header className="bg-[var(--dc-navy)] text-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <BrandMark />
          <form action={devcoreLogoutAction} className="flex min-w-0 items-center gap-3 text-sm">
            <span className="hidden truncate text-white/80 sm:inline">{access.user.name || access.user.email}</span>
            <button type="submit" className="rounded-lg border border-white/30 px-3 py-1.5 font-bold hover:bg-white/10">
              Sair
            </button>
          </form>
        </div>
        <div aria-hidden className="h-1 bg-gradient-to-r from-[var(--dc-purple)] via-[var(--dc-blue)] to-[var(--dc-orange)]" />
      </header>
      <main>
        <DevcoreDashboard key={selected?.id} vms={vms.map(toPublicVm)} initial={initial} initialLive={initialLive} />
      </main>
    </>
  );
}
