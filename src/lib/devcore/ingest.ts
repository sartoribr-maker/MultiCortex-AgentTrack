import type { DevcoreLive, DevcoreMetrics } from "./metrics-schema";

type Ingested = { metrics: DevcoreMetrics; receivedAt: Date };
type IngestedLive = { live: DevcoreLive; receivedAt: Date };

// One process serves the site; globalThis keeps a single store even when the
// route handler and the page are bundled into different server chunks.
const holder = globalThis as { __devcoreIngest?: Map<string, Ingested>; __devcoreLive?: Map<string, IngestedLive> };
const store: Map<string, Ingested> = (holder.__devcoreIngest ??= new Map());
const liveStore: Map<string, IngestedLive> = (holder.__devcoreLive ??= new Map());

export function recordIngest(vmId: string, metrics: DevcoreMetrics, receivedAt = new Date()) {
  store.set(vmId, { metrics, receivedAt });
}

export function latestIngest(vmId: string): Ingested | undefined {
  return store.get(vmId);
}

export function recordLive(vmId: string, live: DevcoreLive, receivedAt = new Date()) {
  liveStore.set(vmId, { live, receivedAt });
}

export function latestLive(vmId: string): IngestedLive | undefined {
  return liveStore.get(vmId);
}

export function clearIngestStore() {
  store.clear();
  liveStore.clear();
}
