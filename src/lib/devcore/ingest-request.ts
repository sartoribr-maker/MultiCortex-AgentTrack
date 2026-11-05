import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { DEVCORE_API_HEADERS } from "./http";
import { findDevcoreVm, type DevcoreVm } from "./registry";

const MAX_BYTES = 2_000_000;

export function ingestReply(status: number, error?: string) {
  return error
    ? Response.json({ error }, { status, headers: DEVCORE_API_HEADERS })
    : new Response(null, { status, headers: DEVCORE_API_HEADERS });
}

function sameToken(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checks the VM token, size and schema of a push. Returns the data or an error response. */
export async function readIngest<T extends z.ZodType>(
  request: Request,
  id: string,
  schema: T,
  label: string,
): Promise<{ vm: DevcoreVm; data: z.infer<T> } | Response> {
  const vm = findDevcoreVm(id);
  // Same answer for unknown VM, pull-mode VM and bad token: nothing to enumerate.
  const expected = vm?.source === "push" ? process.env[vm.tokenEnv]?.trim() : undefined;
  const given = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/)?.[1] ?? "";
  if (!vm || !expected || !given || !sameToken(given, expected)) return ingestReply(401, "Não autorizado.");

  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) return ingestReply(413, "Arquivo grande demais.");
  const text = await request.text();
  if (text.length > MAX_BYTES) return ingestReply(413, "Arquivo grande demais.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return ingestReply(400, "JSON inválido.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.warn(`[devcore] ${label} ${vm.id} recusado: schema (${parsed.error.issues[0]?.path.join(".") || "root"})`);
    return ingestReply(422, "Formato de métricas inválido.");
  }
  return { vm, data: parsed.data };
}
