"use client";

import { BASE_PATH } from "@/lib/base-path";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { DevcoreLiveResult } from "@/lib/devcore/live";
import type { DevcoreMetricsResult } from "@/lib/devcore/metrics";
import type { PublicDevcoreVm } from "@/lib/devcore/registry";
import {
  brasiliaDate, brasiliaMinutes, formatAgo, formatDateBR, formatDuration, formatGigabytes,
  formatInt, formatPercent, formatTimeBR, pocDailySeries, pocProgress,
} from "@/lib/devcore/view";
import { Chart } from "./chart";
import { DevelopersDialog } from "./developers";
import { LiveNow } from "./live";
import { TechnicalOpinion } from "./opinion";

const REFRESH_MS = 60_000;
const S1 = "var(--dc-series-1)";
const S2 = "var(--dc-series-2)";

type Props = { vms: PublicDevcoreVm[]; initial: DevcoreMetricsResult | null; initialLive: DevcoreLiveResult | null };

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function DevcoreDashboard({ vms, initial, initialLive }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [vmId, setVmId] = useState(initial?.vm.id ?? vms[0]?.id ?? "");
  const [result, setResult] = useState<DevcoreMetricsResult | null>(initial);
  /** Last data actually received, kept on screen while the VM is unavailable. */
  const [lastGood, setLastGood] = useState<DevcoreMetricsResult | null>(initial?.metrics ? initial : null);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const now = useNow(1000);
  const vmRef = useRef(vmId);
  useEffect(() => {
    vmRef.current = vmId;
  }, [vmId]);

  const refresh = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const response = await fetch(`${BASE_PATH}/api/devcore/vms/${encodeURIComponent(id)}/metrics`, { cache: "no-store" });
      if (response.status === 401) {
        router.push("/entrar");
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as DevcoreMetricsResult;
      if (vmRef.current !== id) return; // user switched VM meanwhile
      setResult(data);
      if (data.metrics) setLastGood(data);
      setRequestError(null);
      setLoadedAt(Date.now());
    } catch {
      if (vmRef.current === id) setRequestError("Não foi possível falar com o servidor do painel.");
    } finally {
      if (vmRef.current === id) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh(vmRef.current);
    };
    const id = setInterval(tick, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt > REFRESH_MS) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, loadedAt, vmId]);

  function selectVm(id: string) {
    vmRef.current = id;
    setVmId(id);
    setResult(null);
    setLastGood(null);
    router.replace(`${pathname}?vm=${encodeURIComponent(id)}`, { scroll: false });
    void refresh(id);
  }

  const vm = vms.find((v) => v.id === vmId);
  const companies = useMemo(() => {
    const groups = new Map<string, PublicDevcoreVm[]>();
    for (const item of vms) groups.set(item.company, [...(groups.get(item.company) ?? []), item]);
    return [...groups.entries()];
  }, [vms]);

  if (!vm) {
    return (
      <Shell>
        <p className="rounded-xl border border-[var(--dc-border)] bg-white p-6">Nenhuma VM cadastrada em config/devcore-vms.json.</p>
      </Shell>
    );
  }

  const shown = result?.metrics ? result : lastGood?.vm.id === vm.id ? lastGood : null;
  const metrics = shown?.metrics ?? null;
  const status = result?.status ?? (loading ? null : "unavailable");
  const secondsAgo = (now - loadedAt) / 1000;

  return (
    <Shell>
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="flex min-w-0 flex-col gap-1 text-sm font-bold text-[var(--dc-text-muted)] sm:w-80">
          Empresa / POC
          <select
            value={vmId}
            onChange={(event) => selectVm(event.target.value)}
            className="w-full rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2.5 text-base font-bold text-[var(--dc-navy)]"
          >
            {companies.map(([company, items]) => (
              <optgroup key={company} label={company}>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>{item.pocName} · {item.vmName}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3 text-sm text-[var(--dc-text-muted)]">
          <span aria-live="polite" className="dc-num">
            {loading ? "Atualizando…" : `Atualizado há ${formatAgo(secondsAgo)}`}
          </span>
          <button
            type="button"
            onClick={() => void refresh(vmId)}
            disabled={loading}
            className="rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2 font-bold text-[var(--dc-blue)] hover:border-[var(--dc-blue)] disabled:opacity-50"
          >
            Atualizar
          </button>
        </div>
      </section>

      <Header vm={vm} status={status} result={result} metrics={metrics} now={now} />

      <LiveNow
        key={vm.id}
        vmId={vm.id}
        slots={vm.slots}
        initial={vm.id === initial?.vm.id ? initialLive : null}
        now={now}
      />

      {requestError && <Banner tone="alert">{requestError}</Banner>}
      {result?.status === "unavailable" && (
        <Banner tone="alert">
          VM indisponível: o agente não respondeu ({failureText(result.failure)}).
          {metrics ? ` Exibindo os últimos dados recebidos (gerados às ${formatTimeBR(metrics.generated_at)}).` : ""}
        </Banner>
      )}
      {result?.status === "stale" && metrics && (
        <Banner tone="warn">
          Dados atrasados: o agente gerou o último arquivo às {formatTimeBR(metrics.generated_at)}. Verifique o timer na VM.
        </Banner>
      )}

      {metrics ? (
        <div className={result?.status === "unavailable" ? "opacity-70" : undefined}>
          <Indicators metrics={metrics} />
          <Charts metrics={metrics} vm={vm} />
          <TechnicalOpinion metrics={metrics} />
          <p className="mt-6 text-xs text-[var(--dc-text-muted)]">
            Agente {metrics.agent_version} · arquivo gerado às {formatTimeBR(metrics.generated_at)} (Brasília) ·
            linhas inválidas: log {formatInt(metrics.sources.access_log.lines_invalid)}, amostras {formatInt(metrics.sources.samples.lines_invalid)}.
            Requisições = POST /v1/chat/completions. Tempos consideram apenas respostas 2xx.
            {metrics.today.other_requests ? ` Outras requisições pelo mesmo gateway hoje (não DevCore): ${formatInt(metrics.today.other_requests)}.` : ""}
          </p>
        </div>
      ) : (
        !loading && <p className="rounded-xl border border-[var(--dc-border)] bg-white p-6 text-[var(--dc-text-muted)]">Ainda não há dados desta VM.</p>
      )}
    </Shell>
  );
}

function failureText(failure?: string) {
  switch (failure) {
    case "not_configured": return "token ou URL não configurados no servidor";
    case "timeout": return "tempo esgotado";
    case "http": return "resposta HTTP de erro";
    case "invalid": return "arquivo de métricas inválido";
    case "waiting": return "nenhum envio recente do agente da VM";
    default: return "falha de rede";
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">{children}</div>;
}

function Banner({ tone, children }: { tone: "alert" | "warn"; children: React.ReactNode }) {
  const styles = tone === "alert"
    ? "border-[#f5b5c3] bg-[#fdecef] text-[#8f1530]"
    : "border-[#f3cfa9] bg-[#fdf3e8] text-[#8a4310]";
  return (
    <div role="status" className={`flex gap-2 rounded-xl border px-4 py-3 text-sm ${styles}`}>
      <span aria-hidden className="font-bold">!</span>
      <span>{children}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: DevcoreMetricsResult["status"] | null }) {
  if (!status) return <span className="text-sm text-[var(--dc-text-muted)]">Verificando…</span>;
  const map = {
    online: { label: "Online", icon: "●", cls: "bg-[#e6f4ee] text-[#23704f]" },
    stale: { label: "Atrasado", icon: "◐", cls: "bg-[#fdf3e8] text-[#8a4310]" },
    unavailable: { label: "Indisponível", icon: "✕", cls: "bg-[#fdecef] text-[#a3122f]" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${map.cls}`}>
      <span aria-hidden>{map.icon}</span>
      {map.label}
    </span>
  );
}

function Header({ vm, status, result, metrics, now }: {
  vm: PublicDevcoreVm;
  status: DevcoreMetricsResult["status"] | null;
  result: DevcoreMetricsResult | null;
  metrics: DevcoreMetricsResult["metrics"];
  now: number;
}) {
  const progress = pocProgress(vm.pocStart, vm.pocEnd, brasiliaDate(new Date(now)));
  const pct = progress.phase === "active" ? (progress.day / progress.totalDays) * 100 : progress.phase === "ended" ? 100 : 0;
  const phaseText =
    progress.phase === "before" ? `Começa em ${progress.startsIn} ${progress.startsIn === 1 ? "dia" : "dias"}`
    : progress.phase === "ended" ? "POC encerrada"
    : `Dia ${progress.day} de ${progress.totalDays} · ${progress.remaining} ${progress.remaining === 1 ? "dia restante" : "dias restantes"}`;
  return (
    <section className="rounded-xl border border-[var(--dc-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[var(--dc-navy)] sm:text-3xl">{vm.company}</h1>
          <p className="text-[var(--dc-text-muted)]">
            {vm.pocName} · VM <span className="font-bold text-[var(--dc-text)]">{vm.vmName}</span> · {vm.slots} slots
          </p>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <span>Período: <span className="dc-num font-bold">{formatDateBR(vm.pocStart)} – {formatDateBR(vm.pocEnd)}</span></span>
        <span className="dc-num font-bold text-[var(--dc-purple)]">{phaseText}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--dc-grid)]" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso da POC">
        <div className="h-full rounded-full bg-[var(--dc-purple)]" style={{ width: `${pct}%` }} />
      </div>
      {metrics && result?.status !== "unavailable" && (
        <p className="mt-2 text-xs text-[var(--dc-text-muted)]">Dados de hoje ({formatDateBR(metrics.today.date)}), horário de Brasília.</p>
      )}
    </section>
  );
}

function Card({ label, value, detail, tone, onOpen, openLabel }: {
  label: string;
  value: string;
  detail?: string;
  tone?: "ok" | "warn" | "alert";
  /** Makes the card a button that opens a detail view. */
  onOpen?: () => void;
  openLabel?: string;
}) {
  const toneLabel = tone === "alert" ? "Atenção" : tone === "warn" ? "Observar" : null;
  const content = (
    <>
      <span className="text-[13px] font-bold leading-tight text-[var(--dc-text-muted)]">{label}</span>
      <span className="dc-num mt-1 text-2xl font-bold leading-tight text-[var(--dc-navy)] sm:text-[28px]">{value}</span>
      {detail && <span className="dc-num mt-0.5 text-[13px] leading-snug text-[var(--dc-text-muted)]">{detail}</span>}
      {toneLabel && (
        <span className={`mt-1.5 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${tone === "alert" ? "bg-[#fdecef] text-[#a3122f]" : "bg-[#fdf3e8] text-[#8a4310]"}`}>
          <span aria-hidden>{tone === "alert" ? "▲" : "●"}</span>{toneLabel}
        </span>
      )}
      {onOpen && <span className="mt-1.5 text-[13px] font-bold text-[var(--dc-blue)]">{openLabel} ›</span>}
    </>
  );
  const box = "flex min-w-0 flex-col rounded-xl border border-[var(--dc-border)] bg-white p-3 sm:p-4";
  if (!onOpen) return <div className={box}>{content}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={`${box} text-left hover:border-[var(--dc-blue)] focus-visible:border-[var(--dc-blue)]`}
    >
      {content}
    </button>
  );
}

export function Indicators({ metrics, pseudonymous = false }: { metrics: NonNullable<DevcoreMetricsResult["metrics"]>; pseudonymous?: boolean }) {
  const t = metrics.today;
  const errorPct = t.error_rate * 100;
  const [showDevelopers, setShowDevelopers] = useState(false);
  return (
    <section aria-label="Indicadores de hoje" className="mt-1 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      <Card label="Requisições hoje" value={formatInt(t.requests)} detail={`${formatInt(t.requests_ok)} com sucesso`} />
      <Card
        label="Desenvolvedores ativos hoje"
        value={formatInt(t.developers)}
        detail={pseudonymous ? "Identificadores de origem com chamada bem-sucedida" : "IPs distintos com chamada bem-sucedida"}
        // Agent 1.3+ sends the per-IP breakdown; older agents only the count.
        onOpen={t.developer_list ? () => setShowDevelopers(true) : undefined}
        openLabel="Ver por desenvolvedor"
      />
      {t.developer_list && (
        <DevelopersDialog
          developers={t.developer_list}
          pseudonymous={pseudonymous}
          date={t.date}
          generatedAt={metrics.generated_at}
          open={showDevelopers}
          onClose={() => setShowDevelopers(false)}
        />
      )}
      <Card label="Tempo de resposta" value={formatDuration(t.latency_s.p50)} detail={`mediana · p95 ${formatDuration(t.latency_s.p95)}`} />
      <Card label="Espera até o modelo responder" value={formatDuration(t.ttfb_s.p50)} detail={`mediana · p95 ${formatDuration(t.ttfb_s.p95)}`} />
      <Card
        label="Taxa de erro (4xx/5xx)"
        value={formatPercent(errorPct)}
        detail={`4xx ${formatInt(t.errors_4xx)} · 5xx ${formatInt(t.errors_5xx)} · canceladas ${formatInt(t.cancelled_499)}`}
        tone={errorPct >= 5 ? "alert" : errorPct >= 1 ? "warn" : undefined}
      />
      {t.inflight ? (
        <>
          <Card
            label="Pico de requisições simultâneas"
            value={formatInt(t.inflight.peak.total)}
            detail={`DevCore ${formatInt(t.inflight.peak.devcore)} · outros ${formatInt(t.inflight.peak.other)} · conexões TCP ${formatInt(t.conn_peak.total)}`}
          />
          <Card
            label={`Tempo com ≥ ${metrics.slots} requisições`}
            value={formatPercent(t.inflight.saturation_pct.total)}
            detail={`slots esgotados · só DevCore ${formatPercent(t.inflight.saturation_pct.devcore)}`}
            tone={t.inflight.saturation_pct.total >= 10 ? "alert" : t.inflight.saturation_pct.total > 0 ? "warn" : undefined}
          />
        </>
      ) : (
        <>
          <Card label="Pico de conexões simultâneas" value={formatInt(t.conn_peak.total)} detail={`DevCore ${formatInt(t.conn_peak.devcore)} · site ${formatInt(t.conn_peak.site)}`} />
          <Card
            label={`Tempo com ≥ ${metrics.slots} conexões`}
            value={formatPercent(t.saturation_pct.total)}
            detail={`slots possivelmente esgotados · só DevCore ${formatPercent(t.saturation_pct.devcore)}`}
            tone={t.saturation_pct.total >= 10 ? "alert" : t.saturation_pct.total > 0 ? "warn" : undefined}
          />
        </>
      )}
      <Card label="Uso da GPU" value={formatPercent(t.gpu.util_avg, 0)} detail={`média · máx. ${formatPercent(t.gpu.util_max, 0)} · VRAM máx. ${formatGigabytes(t.gpu.mem_mb_max)}`} />
    </section>
  );
}

function hourTicks(starts: string[]) {
  return starts
    .map((start, i) => ({ value: i, label: `${formatTimeBR(start).slice(0, 2)}h` }))
    .filter((_, i) => (i - (starts.length - 1)) % 4 === 0);
}

const DAY_TICKS = [0, 360, 720, 1080, 1440].map((value) => ({ value, label: `${String(value / 60).padStart(2, "0")}h` }));

export function Charts({ metrics, vm }: { metrics: NonNullable<DevcoreMetricsResult["metrics"]>; vm: PublicDevcoreVm }) {
  const hours = metrics.hourly_24h;
  const hourIndex = hours.map((_, i) => i);
  const hourLabels = hours.map((h) => `${formatDateBR(brasiliaDate(new Date(h.start)), true)} ${formatTimeBR(h.start)}`);

  const points = metrics.timeline_today.points;
  const minutes = points.map((p) => brasiliaMinutes(p.t));
  const pointLabels = points.map((p) => formatTimeBR(p.t));
  const gap = (metrics.timeline_today.interval_s / 60) * 2.5;
  const memTotal = metrics.today.gpu.mem_mb_total;
  const hasInflight = Boolean(metrics.today.inflight);

  const days = pocDailySeries(metrics.daily, vm.pocStart, vm.pocEnd, metrics.today.date);
  const dayIndex = days.map((_, i) => i);
  const dayLabels = days.map((d) => formatDateBR(d.date));
  const dayTicks = days
    .map((d, i) => ({ value: i, label: formatDateBR(d.date, true) }))
    .filter((_, i, all) => all.length <= 8 || i % Math.ceil(all.length / 6) === 0 || i === all.length - 1);

  return (
    <section aria-label="Gráficos" className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Chart
        title="Requisições por hora"
        subtitle="Últimas 24 horas"
        kind="bar"
        x={hourIndex} xDomain={[0, 23]} xTicks={hourTicks(hours.map((h) => h.start))} xLabels={hourLabels}
        series={[{ key: "req", label: "Requisições", color: S1, values: hours.map((h) => h.requests) }]}
        yFormat={(v) => formatInt(Math.round(v))}
        integer
        yMaxAtLeast={4}
      />
      <Chart
        title="Tempo de resposta por hora"
        subtitle="Mediana (p50) e p95, últimas 24 horas"
        kind="line"
        x={hourIndex} xDomain={[0, 23]} xTicks={hourTicks(hours.map((h) => h.start))} xLabels={hourLabels}
        series={[
          { key: "p50", label: "p50", color: S1, values: hours.map((h) => h.p50) },
          { key: "p95", label: "p95", color: S2, values: hours.map((h) => h.p95) },
        ]}
        yFormat={formatDuration}
        gapAbove={1}
      />
      <Chart
        title={hasInflight ? "Requisições simultâneas hoje" : "Conexões simultâneas hoje"}
        subtitle={`Máximo a cada ${metrics.timeline_today.interval_s / 60} min`}
        kind="line"
        x={minutes} xDomain={[0, 1440]} xTicks={DAY_TICKS} xLabels={pointLabels}
        series={hasInflight ? [
          { key: "devcore", label: "DevCore", color: S1, values: points.map((p) => p.inflight_devcore_max ?? null) },
          { key: "other", label: "Outros (mesmo gateway)", color: S2, values: points.map((p) => p.inflight_other_max ?? null) },
        ] : [
          { key: "devcore", label: "DevCore", color: S1, values: points.map((p) => p.conn_devcore_max) },
          { key: "site", label: "Site (35.168.36.x)", color: S2, values: points.map((p) => p.conn_site_max) },
        ]}
        yFormat={(v) => formatInt(Math.round(v))}
        integer
        reference={{ value: metrics.slots, label: `${metrics.slots} slots` }}
        gapAbove={gap}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Chart
          title="Uso da GPU hoje"
          subtitle="Média a cada 5 min (%)"
          kind="line"
          x={minutes} xDomain={[0, 1440]} xTicks={DAY_TICKS} xLabels={pointLabels}
          series={[{ key: "gpu", label: "GPU", color: S1, values: points.map((p) => p.gpu_util_avg) }]}
          yFormat={(v) => `${Math.round(v)}%`}
          yMaxFixed={100}
          gapAbove={gap}
          height={180}
        />
        <Chart
          title="VRAM hoje"
          subtitle={memTotal ? `Máximo a cada 5 min · total ${formatGigabytes(memTotal)}` : "Máximo a cada 5 min"}
          kind="line"
          x={minutes} xDomain={[0, 1440]} xTicks={DAY_TICKS} xLabels={pointLabels}
          series={[{ key: "mem", label: "VRAM", color: S1, values: points.map((p) => (p.gpu_mem_mb_max == null ? null : p.gpu_mem_mb_max / 1024)) }]}
          yFormat={(v) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 1 : 0 })} GB`}
          yMaxFixed={memTotal ? memTotal / 1024 : undefined}
          gapAbove={gap}
          height={180}
        />
      </div>
      <Chart
        title="POC inteira: requisições por dia"
        subtitle={`${formatDateBR(vm.pocStart)} a ${formatDateBR(vm.pocEnd)}`}
        kind="bar"
        x={dayIndex} xDomain={[0, Math.max(0, days.length - 1)]} xTicks={dayTicks} xLabels={dayLabels}
        series={[{ key: "req", label: "Requisições", color: S1, values: days.map((d) => d.entry?.requests ?? null) }]}
        yFormat={(v) => formatInt(Math.round(v))}
        integer
        yMaxAtLeast={4}
        emptyMessage="A POC ainda não começou."
      />
      <Chart
        title="POC inteira: tempo de resposta p95 por dia"
        subtitle="Dias sem registro do agente ficam em branco"
        kind="line"
        x={dayIndex} xDomain={[0, Math.max(1, days.length - 1)]} xTicks={dayTicks} xLabels={dayLabels}
        series={[{ key: "p95", label: "p95", color: S2, values: days.map((d) => d.entry?.p95 ?? null) }]}
        yFormat={formatDuration}
        gapAbove={1}
        emptyMessage="A POC ainda não começou."
      />
    </section>
  );
}
