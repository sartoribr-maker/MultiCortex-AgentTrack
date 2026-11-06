import "server-only";
import { saveOperational } from "./operational-store";
import { recordGpuHistory } from "./telemetry-history";

import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { UniversalTelemetry } from "./agent-telemetry";

const BASE_DIR =
  process.env.DEVCORE_TELEMETRY_DIR ||
  "/var/lib/devcore-monitor/telemetry";

export function saveUniversalTelemetry(
  agentId: string,
  data: UniversalTelemetry
): void {
  if (!/^[a-f0-9-]{36}$/.test(agentId)) {
    throw new Error("Identificador inválido");
  }

  const path = join(BASE_DIR, agentId + ".json");
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const temp = join(
    dir,
    "." + agentId + "-" + randomBytes(8).toString("hex") + ".tmp"
  );

  const fd = openSync(temp, "wx", 0o600);

  try {
    writeFileSync(
      fd,
      JSON.stringify({
        receivedAt: new Date().toISOString(),
        ...data,
      })
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temp, path);
  if (process.env.DEVCORE_POC_MODE === "1") {
    if (data.metrics.operational) {
      try { saveOperational(agentId, data.metrics.operational); }
      catch { console.error("[devcore] Não foi possível persistir resumo operacional"); }
    }
    try { recordGpuHistory(agentId, data); }
    catch { console.error("[devcore] Não foi possível registrar o histórico de GPU"); }
  }
}

export function getUniversalTelemetry(agentId: string) {
  if (!/^[a-f0-9-]{36}$/.test(agentId)) {
    return null;
  }

  try {
    return JSON.parse(
      readFileSync(join(BASE_DIR, agentId + ".json"), "utf8")
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
