"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DevcoreLiveResult } from "@/lib/devcore/live";
import { LIVE_FRESH_MS, formatAgo, formatGigabytes, formatInt, formatPercent } from "@/lib/devcore/view";

const LIVE_REFRESH_MS = 10_000;

type Props = { vmId: string; slots: number; initial: DevcoreLiveResult | null; now: number };

/** "Agora": developers online and slot/GPU use at this moment, refreshed every 10 s. */
export function LiveNow({ vmId, slots, initial, now }: Props) {
  const router = useRouter();
  const [result, setResult] = useState<DevcoreLiveResult | null>(initial);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/devcore/vms/${encodeURIComponent(vmId)}/live`, { cache: "no-store" });
      if (response.status === 401) {
        router.push("/entrar");
        return;
      }
      if (!response.ok) return; // keep the last snapshot; its age shows it is getting old
      setResult((await response.json()) as DevcoreLiveResult);
      setLoadedAt(Date.now());
    } catch {
      // Network hiccup: same as above.
    }
  }, [vmId, router]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    // Switched VM (no server-rendered snapshot): fetch right away.
    const first = initial ? undefined : setTimeout(tick, 0);
    const id = setInterval(tick, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, initial]);

  const live = result?.live ?? null;
  const ageMs = result?.ageMs == null ? null : result.ageMs + Math.max(0, now - loadedAt);
  const fresh = ageMs != null && ageMs <= LIVE_FRESH_MS;

  return (
    <section aria-label="Agora" className="rounded-xl border border-[var(--dc-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--dc-navy)]">
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 rounded-full ${fresh ? "bg-[var(--dc-ok)] motion-safe:animate-pulse" : "bg-[var(--dc-text-muted)]"}`}
          />
          Agora
        </h2>
        <span className="dc-num text-sm text-[var(--dc-text-muted)]">
          {ageMs == null ? "Sem retrato ao vivo" : `${fresh ? "Ao vivo" : "Parado"} · retrato de ${formatAgo(ageMs / 1000)} atrás`}
        </span>
      </div>

      {live ? (
        <>
          <div className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 ${fresh ? "" : "opacity-60"}`}>
            <Developers live={live} />
            <Slots live={live} slots={slots} />
            <Tile
              label="GPU agora"
              value={formatPercent(live.gpu.util, 0)}
              detail={`VRAM ${formatGigabytes(live.gpu.mem_mb)}${live.gpu.mem_mb_total ? ` de ${formatGigabytes(live.gpu.mem_mb_total)}` : ""}`}
            />
          </div>
          {!fresh && (
            <p role="status" className="mt-3 text-sm text-[#8a4310]">
              A captura da VM parou de enviar. Os números acima são do último retrato recebido.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-[var(--dc-text-muted)]">
          Aguardando o primeiro retrato da VM. Ele é enviado a cada 10 s pela captura passiva (versão 1.3 ou mais nova).
        </p>
      )}
    </section>
  );
}

function Tile({ label, value, detail, children }: { label: string; value: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-[var(--dc-bg)] p-3 sm:p-4">
      <span className="text-[13px] font-bold leading-tight text-[var(--dc-text-muted)]">{label}</span>
      <span className="dc-num mt-1 text-3xl font-bold leading-tight text-[var(--dc-navy)]">{value}</span>
      {children}
      {detail && <span className="dc-num mt-1 text-[13px] leading-snug text-[var(--dc-text-muted)]">{detail}</span>}
    </div>
  );
}

function Developers({ live }: { live: NonNullable<DevcoreLiveResult["live"]> }) {
  const { online, active } = live.developers;
  const minutes = Math.round(live.window_s / 60);
  return (
    <Tile
      label="Desenvolvedores on-line"
      value={formatInt(online)}
      detail={`${formatInt(active)} com requisição em andamento · uso nos últimos ${minutes} min`}
    />
  );
}

function Slots({ live, slots }: { live: NonNullable<DevcoreLiveResult["live"]>; slots: number }) {
  const { devcore, other } = live.inflight;
  const total = devcore + other;
  const queued = Math.max(0, total - slots);
  // Scale to the slots, or to the demand when it exceeds them (the excess waits in line).
  const scale = Math.max(slots, total);
  return (
    <Tile
      label="Slots em uso"
      value={`${formatInt(Math.min(total, slots))} de ${formatInt(slots)}`}
      detail={`DevCore ${formatInt(devcore)} · outros ${formatInt(other)}${queued ? ` · ${formatInt(queued)} na fila` : ""}`}
    >
      <div
        role="meter"
        aria-label="Slots em uso"
        aria-valuemin={0}
        aria-valuemax={slots}
        aria-valuenow={Math.min(total, slots)}
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-[var(--dc-grid)]"
      >
        <div className="h-full bg-[var(--dc-series-1)]" style={{ width: `${(devcore / scale) * 100}%` }} />
        <div className="h-full bg-[var(--dc-series-2)]" style={{ width: `${(other / scale) * 100}%` }} />
      </div>
      {queued > 0 && (
        <span className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-full bg-[#fdecef] px-2 py-0.5 text-xs font-bold text-[#a3122f]">
          <span aria-hidden>▲</span>Slots esgotados
        </span>
      )}
    </Tile>
  );
}
