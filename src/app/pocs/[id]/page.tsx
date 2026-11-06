import { notFound, redirect } from "next/navigation";
import { pocMode } from "@/lib/devcore/poc-store";
import { getDevcoreAccess } from "@/lib/devcore/session";
import { PocShell } from "@/components/devcore/poc-shell";
export default async function PocPage({ params }: { params: Promise<{ id: string }> }) {
  if (!pocMode()) notFound();
  const access = await getDevcoreAccess();
  if (!access.ok) redirect("/entrar");
  return <PocShell pocId={(await params).id} />;
}
