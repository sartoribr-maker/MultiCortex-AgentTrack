import "server-only";
import { latestLive } from "./ingest";
import type { DevcoreLive } from "./metrics-schema";
import type { DevcoreVm } from "./registry";
import { LIVE_FRESH_MS } from "./view";

export type DevcoreLiveResult = {
  live: DevcoreLive | null;
  /** When the site received the snapshot (site clock, so VM clock skew does not matter). */
  receivedAt: string | null;
  /** Age of the snapshot when this answer was built (the browser adds its own elapsed time). */
  ageMs: number | null;
  fresh: boolean;
};

export function getDevcoreLive(vm: DevcoreVm, now = new Date()): DevcoreLiveResult {
  const latest = latestLive(vm.id);
  if (!latest) return { live: null, receivedAt: null, ageMs: null, fresh: false };
  const ageMs = Math.max(0, now.getTime() - latest.receivedAt.getTime());
  return { live: latest.live, receivedAt: latest.receivedAt.toISOString(), ageMs, fresh: ageMs <= LIVE_FRESH_MS };
}
