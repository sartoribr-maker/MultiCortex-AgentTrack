import { readFileSync } from "node:fs";
import { z } from "zod";
import bundledRegistry from "../../../config/devcore-vms.json";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const vmSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  company: z.string().min(1),
  pocName: z.string().min(1),
  vmName: z.string().min(1),
  pocStart: isoDate,
  pocEnd: isoDate,
  slots: z.number().int().positive().default(8),
  // push: the VM agent POSTs metrics to /api/devcore/ingest/<id> (outbound only).
  // pull: the site fetches metricsUrl from the VM (needs an inbound port).
  source: z.enum(["push", "pull"]).default("pull"),
  metricsUrl: z.string().url().optional(),
  // Name of the environment variable that holds the token — never the token.
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
});

const registrySchema = z.object({ vms: z.array(vmSchema) });

export type DevcoreVm = z.infer<typeof vmSchema>;
/** What the browser may see about a VM: no URL, no token variable name. */
export type PublicDevcoreVm = Pick<DevcoreVm, "id" | "company" | "pocName" | "vmName" | "pocStart" | "pocEnd" | "slots">;

export function parseRegistry(data: unknown): DevcoreVm[] {
  const { vms } = registrySchema.parse(data);
  const ids = new Set<string>();
  for (const vm of vms) {
    if (ids.has(vm.id)) throw new Error(`VM duplicada no cadastro DevCore: ${vm.id}`);
    ids.add(vm.id);
    if (vm.pocEnd < vm.pocStart) throw new Error(`Período inválido na VM ${vm.id}`);
    if (vm.source === "pull" && !vm.metricsUrl) throw new Error(`VM ${vm.id}: modo pull exige metricsUrl`);
  }
  return vms;
}

let cached: { source: string; vms: DevcoreVm[] } | null = null;

/**
 * VM registry. DEVCORE_VMS_FILE (a JSON file mounted on the server) overrides
 * the bundled config/devcore-vms.json, so a VM can be added without rebuild.
 */
export function listDevcoreVms(): DevcoreVm[] {
  const file = process.env.DEVCORE_VMS_FILE?.trim();
  const source = file || "bundled";
  if (cached?.source === source) return cached.vms;
  const data = file ? JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8")) : bundledRegistry;
  cached = { source, vms: parseRegistry(data) };
  return cached.vms;
}

export function findDevcoreVm(id: string | null | undefined): DevcoreVm | undefined {
  if (!id) return undefined;
  return listDevcoreVms().find((vm) => vm.id === id);
}

export function toPublicVm(vm: DevcoreVm): PublicDevcoreVm {
  const { id, company, pocName, vmName, pocStart, pocEnd, slots } = vm;
  return { id, company, pocName, vmName, pocStart, pocEnd, slots };
}

export function resetDevcoreRegistryCache() {
  cached = null;
}
