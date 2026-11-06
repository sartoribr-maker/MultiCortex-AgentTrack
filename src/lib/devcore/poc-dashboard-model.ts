import type { GpuHistoryPoint, PodView } from "./poc-model";

/** Aggregate measured buckets only. Missing buckets remain gaps, never zeros. */
export function combineGpuHistory(pods: PodView[]): GpuHistoryPoint[] {
  const buckets = new Map<string, GpuHistoryPoint[]>();
  for (const pod of pods) for (const point of pod.gpuHistory ?? []) {
    const values = buckets.get(point.t) ?? []; values.push(point); buckets.set(point.t, values);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, points]) => {
    const measured = points.filter(p => p.utilization !== null);
    const weights = measured.reduce((sum, p) => sum + p.samples, 0);
    const maxima = points.flatMap(p => (p.maximum ?? p.utilization) === null ? [] : [p.maximum ?? p.utilization!]);
    const used = points.flatMap(p => p.memoryUsed === null ? [] : [p.memoryUsed]);
    const total = points.flatMap(p => p.memoryTotal === null ? [] : [p.memoryTotal]);
    return { t, utilization: weights ? measured.reduce((sum, p) => sum + p.utilization! * p.samples, 0) / weights : null,
      maximum: maxima.length ? Math.max(...maxima) : null,
      memoryUsed: used.length ? used.reduce((a, b) => a + b, 0) : null,
      memoryTotal: total.length ? total.reduce((a, b) => a + b, 0) : null,
      samples: weights || points.reduce((sum, p) => sum + p.samples, 0) };
  });
}
export function gpuDayStats(points: GpuHistoryPoint[]) {
  const measured = points.filter(p => p.utilization !== null);
  const weights = measured.reduce((sum, p) => sum + p.samples, 0);
  const memory = points.flatMap(p => p.memoryUsed === null ? [] : [p.memoryUsed]);
  return { average: weights ? measured.reduce((sum, p) => sum + p.utilization! * p.samples, 0) / weights : null,
    maximum: measured.length ? Math.max(...measured.map(p => p.maximum ?? p.utilization!)) : null,
    memoryMax: memory.length ? Math.max(...memory) : null };
}
