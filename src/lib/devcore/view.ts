// Pure presentation helpers for the DevCore dashboard (Brasilia time, pt-BR).
// Brazil has had no daylight saving time since 2019, so UTC-3 is fixed.
export const BRT_OFFSET_MINUTES = -180;
const DAY_MS = 86_400_000;

type DailyEntry = {
  date: string;
  requests: number;
  errors: number;
  developers: number;
  p50: number | null;
  p95: number | null;
};

function shiftToBrasilia(date: Date): Date {
  return new Date(date.getTime() + BRT_OFFSET_MINUTES * 60_000);
}

/** YYYY-MM-DD of the given instant in Brasilia. */
export function brasiliaDate(now: Date): string {
  return shiftToBrasilia(now).toISOString().slice(0, 10);
}

function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

function isoFromDayNumber(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export type PocProgress = {
  phase: "before" | "active" | "ended";
  totalDays: number;
  /** 1-based day of the POC (clamped to the period). */
  day: number;
  /** Days left after today; 0 on the last day. */
  remaining: number;
  /** Days until the start when phase is "before". */
  startsIn: number;
};

export function pocProgress(start: string, end: string, today: string): PocProgress {
  const s = dayNumber(start);
  const e = dayNumber(end);
  const t = dayNumber(today);
  const totalDays = e - s + 1;
  if (t < s) return { phase: "before", totalDays, day: 0, remaining: totalDays, startsIn: s - t };
  if (t > e) return { phase: "ended", totalDays, day: totalDays, remaining: 0, startsIn: 0 };
  return { phase: "active", totalDays, day: t - s + 1, remaining: e - t, startsIn: 0 };
}

/**
 * One entry per POC day up to today. Days the agent has no record of stay
 * null (unknown), which is different from a day with zero requests.
 */
export function pocDailySeries<T extends DailyEntry>(daily: T[], start: string, end: string, today: string) {
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const last = Math.min(dayNumber(end), dayNumber(today));
  const result: { date: string; entry: T | null }[] = [];
  for (let day = dayNumber(start); day <= last; day++) {
    const date = isoFromDayNumber(day);
    result.push({ date, entry: byDate.get(date) ?? null });
  }
  return result;
}

const intFormat = new Intl.NumberFormat("pt-BR");
const oneDecimal = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const twoSignificant = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export const DASH = "—";

export function formatInt(value: number | null | undefined): string {
  return value == null ? DASH : intFormat.format(value);
}

/** Seconds → "820 ms", "4,2 s", "1 min 05 s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return DASH;
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${oneDecimal.format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} min ${String(rest).padStart(2, "0")} s`;
}

/** Already a percentage (0–100). */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null) return DASH;
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value)}%`;
}

export function formatGigabytes(megabytes: number | null | undefined): string {
  return megabytes == null ? DASH : `${twoSignificant.format(megabytes / 1024)} GB`;
}

/** "2026-10-13" → "13/10/2026" (or "13/10" when short). */
export function formatDateBR(isoDate: string, short = false): string {
  const [year, month, day] = isoDate.split("-");
  return short ? `${day}/${month}` : `${day}/${month}/${year}`;
}

/** Instant → "14:05" in Brasilia. */
export function formatTimeBR(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return shiftToBrasilia(date).toISOString().slice(11, 16);
}

/** Minutes since Brasilia midnight for an instant. */
export function brasiliaMinutes(iso: string): number {
  const shifted = shiftToBrasilia(new Date(iso));
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes() + shifted.getUTCSeconds() / 60;
}

/** "atualizado há 12 s / 3 min / 2 h". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/** The VM capture pushes every 10 s; after three missed pushes the snapshot no longer describes "now". */
export const LIVE_FRESH_MS = 30_000;

/** Time a developer was active: "< 1 min", "42 min", "2 h 05 min". */
export function formatActiveTime(seconds: number): string {
  if (seconds < 60) return "< 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Same window as the live card's "online": a call in the 5 min before the file was generated. */
export function isRecentlyActive(lastSeen: string, generatedAt: string): boolean {
  return Date.parse(generatedAt) - Date.parse(lastSeen) <= 300_000;
}
