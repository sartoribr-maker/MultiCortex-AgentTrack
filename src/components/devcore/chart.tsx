"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  /** One value per x position; null = no data (a gap, never a zero). */
  values: (number | null)[];
};

type Props = {
  title: string;
  subtitle?: string;
  kind: "line" | "bar";
  /** X positions in domain units (e.g. hour index or minutes of day). */
  x: number[];
  xDomain: [number, number];
  xTicks: { value: number; label: string }[];
  /** Label for each x position, used by the tooltip and the table. */
  xLabels: string[];
  series: ChartSeries[];
  yFormat: (value: number) => string;
  yMin?: number;
  /** Lower bound for the top of the y axis (e.g. 100 for percentages). */
  yMaxAtLeast?: number;
  yMaxFixed?: number;
  /** Counts: keep every y tick an integer (no "8" label that really is 7.5). */
  integer?: boolean;
  reference?: { value: number; label: string };
  /** Break the line when two points are further apart than this. */
  gapAbove?: number;
  height?: number;
  emptyMessage?: string;
};

const MARGIN = { top: 12, right: 12, bottom: 26 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * exponent >= value) return step * exponent;
  }
  return 10 * exponent;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Chart({
  title, subtitle, kind, x, xDomain, xTicks, xLabels, series, yFormat,
  yMin = 0, yMaxAtLeast = 0, yMaxFixed, integer = false, reference, gapAbove, height = 220,
  emptyMessage = "Sem dados no período.",
}: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const tableId = useId();

  const hasData = series.some((s) => s.values.some((v) => v != null));
  const dataMax = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null)));
  const autoMax = niceMax(Math.max(dataMax, yMaxAtLeast, reference ? reference.value * 1.15 : 0, yMin + 1e-9));
  const yMax = yMaxFixed ?? (integer ? Math.ceil(autoMax / 4) * 4 : autoMax);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  // Room for the widest y label (11px tabular digits ≈ 6.5px each).
  const left = Math.max(32, Math.ceil(Math.max(...yTicks.map((t) => yFormat(t).length)) * 6.5) + 12);
  const innerW = Math.max(0, width - left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const span = xDomain[1] - xDomain[0] || 1;
  const band = kind === "bar" ? innerW / Math.max(1, x.length) : 0;
  const sx = (value: number) =>
    kind === "bar"
      ? band * x.indexOf(value) + band / 2
      : ((value - xDomain[0]) / span) * innerW;
  const sy = (value: number) => innerH - ((value - yMin) / (yMax - yMin || 1)) * innerH;

  const paths = useMemo(() => {
    if (kind !== "line" || innerW <= 0) return [];
    return series.map((s) => {
      let d = "";
      let previous: number | null = null;
      let run: number[] = [];
      // A point with no neighbour draws no line; it gets a dot instead.
      const isolated: number[] = [];
      const closeRun = () => {
        if (run.length === 1) isolated.push(run[0]);
        run = [];
      };
      s.values.forEach((value, i) => {
        if (value == null) {
          previous = null;
          closeRun();
          return;
        }
        const broken = previous == null || (gapAbove != null && x[i] - x[previous] > gapAbove);
        if (broken) closeRun();
        d += `${broken ? "M" : "L"}${sx(x[i]).toFixed(1)},${sy(value).toFixed(1)}`;
        run.push(i);
        previous = i;
      });
      closeRun();
      return { key: s.key, color: s.color, d, isolated, values: s.values };
    });
    // sx/sy depend only on the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, series, x, innerW, innerH, yMax, yMin, span, gapAbove, band]);

  function onPointer(event: React.PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best = 0;
    let bestDistance = Infinity;
    x.forEach((value, i) => {
      const distance = Math.abs(sx(value) - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    setHover(best);
  }

  const barGap = 2;
  const barWidth = Math.max(1, band / Math.max(1, series.length) - barGap);
  const hoverX = hover != null ? sx(x[hover]) : 0;
  const tooltipLeft = hover != null ? Math.min(Math.max(left + hoverX, 80), Math.max(80, width - 80)) : 0;

  return (
    <figure className="flex min-w-0 flex-col rounded-xl border border-[var(--dc-border)] bg-[var(--dc-surface)] p-4">
      <figcaption className="mb-2">
        <h3 className="text-base font-bold text-[var(--dc-navy)]">{title}</h3>
        {subtitle && <p className="text-sm text-[var(--dc-text-muted)]">{subtitle}</p>}
        {series.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--dc-text)]">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
            {reference && (
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block w-3 border-t-2 border-dashed border-[var(--dc-alert)]" />
                {reference.label}
              </li>
            )}
          </ul>
        )}
      </figcaption>

      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--dc-text-muted)]">
            {emptyMessage}
          </div>
        )}
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${title}. Detalhes na tabela abaixo.`} className="block select-none">
            <g transform={`translate(${left},${MARGIN.top})`}>
              {yTicks.map((tick) => (
                <g key={tick}>
                  <line x1={0} x2={innerW} y1={sy(tick)} y2={sy(tick)} stroke="var(--dc-grid)" />
                  <text x={-8} y={sy(tick)} dy="0.32em" textAnchor="end" className="dc-num" fontSize={11} fill="var(--dc-text-muted)">
                    {yFormat(tick)}
                  </text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <text key={tick.value} x={sx(tick.value)} y={innerH + 18} textAnchor={sx(tick.value) < 16 ? "start" : sx(tick.value) > innerW - 16 ? "end" : "middle"} className="dc-num" fontSize={11} fill="var(--dc-text-muted)">
                  {tick.label}
                </text>
              ))}
              <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--dc-border)" />

              {kind === "bar" &&
                series.map((s, si) =>
                  s.values.map((value, i) => {
                    if (value == null || value <= 0) return null;
                    const x0 = +(band * i + barGap / 2 + si * (barWidth + barGap)).toFixed(1);
                    const top = +sy(value).toFixed(1);
                    const h = innerH - top;
                    const r = +Math.min(4, barWidth / 2, h).toFixed(1);
                    // Rounded data end, square baseline.
                    const d = `M${x0},${innerH}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barWidth - r}Q${x0 + barWidth},${top} ${x0 + barWidth},${top + r}V${innerH}Z`;
                    return <path key={`${s.key}-${i}`} d={d} fill={s.color} opacity={hover == null || hover === i ? 1 : 0.55} />;
                  }),
                )}

              {kind === "line" &&
                paths.map((p) => (
                  <g key={p.key}>
                    <path d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    {p.isolated.map((i) => (
                      <circle key={i} cx={sx(x[i])} cy={sy(p.values[i] as number)} r={4} fill={p.color} stroke="var(--dc-surface)" strokeWidth={2} />
                    ))}
                  </g>
                ))}

              {reference && reference.value <= yMax && (
                <g>
                  <line x1={0} x2={innerW} y1={sy(reference.value)} y2={sy(reference.value)} stroke="var(--dc-alert)" strokeWidth={1.5} strokeDasharray="5 4" />
                  <text x={innerW} y={sy(reference.value) - 5} textAnchor="end" fontSize={11} fontWeight={700} fill="#b4163a">
                    {reference.label}
                  </text>
                </g>
              )}

              {hover != null && kind === "line" && (
                <g pointerEvents="none">
                  <line x1={hoverX} x2={hoverX} y1={0} y2={innerH} stroke="var(--dc-text-muted)" strokeDasharray="2 3" />
                  {series.map((s) =>
                    s.values[hover] == null ? null : (
                      <circle key={s.key} cx={hoverX} cy={sy(s.values[hover] as number)} r={4.5} fill={s.color} stroke="var(--dc-surface)" strokeWidth={2} />
                    ),
                  )}
                </g>
              )}

              <rect
                x={0} y={0} width={innerW} height={innerH} fill="transparent"
                onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => setHover(null)}
                style={{ touchAction: "pan-y" }}
              />
            </g>
          </svg>
        )}
        {hover != null && hasData && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-[140px] -translate-x-1/2 rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2 text-sm shadow-md"
            style={{ left: tooltipLeft }}
          >
            <div className="mb-1 font-bold text-[var(--dc-navy)]">{xLabels[hover]}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="dc-num font-bold">{s.values[hover] == null ? "—" : yFormat(s.values[hover] as number)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-[var(--dc-blue)]" aria-controls={tableId}>Ver tabela</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table id={tableId} className="dc-num w-full text-left">
            <thead>
              <tr className="border-b border-[var(--dc-border)] text-[var(--dc-text-muted)]">
                <th className="py-1 pr-3 font-bold">Período</th>
                {series.map((s) => <th key={s.key} className="py-1 pr-3 font-bold">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {x.map((_, i) => (
                <tr key={i} className="border-b border-[var(--dc-grid)]">
                  <td className="py-1 pr-3">{xLabels[i]}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 pr-3">{s.values[i] == null ? "—" : yFormat(s.values[i] as number)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
