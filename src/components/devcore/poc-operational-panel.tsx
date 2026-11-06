"use client";
import { Indicators, Charts } from "./dashboard";
import { TechnicalOpinion } from "./opinion";
import { formatInt, formatPercent, formatGigabytes, formatTimeBR, brasiliaDate, formatDateBR } from "@/lib/devcore/view";
import type { PocView, PodView } from "@/lib/devcore/poc-model";

export function PocOperationalPanel({ poc, pod, updatedAt }: { poc: PocView; pod: PodView; updatedAt: string }) {
  const report = pod.operational, metrics = report?.metrics;
  if (!report || !metrics) return null;
  const live = report.live;
  const now = Date.parse(updatedAt);
  const age = live ? now - Date.parse(live.generated_at) : Infinity;
  const liveFresh = report.fresh && pod.online && age >= -10000 && age <= 60000;
  const busy = liveFresh && live ? live.inflight.devcore + live.inflight.other : null;
  const freshDay = metrics.today.date === brasiliaDate(new Date(now));
  const vm = { id: pod.id, company: poc.client, pocName: poc.name, vmName: pod.name,
    pocStart: poc.startDate, pocEnd: poc.endDate, slots: metrics.slots };
  return <div className="space-y-4" aria-label="Monitoramento operacional da POD">
    {(!report.fresh || !freshDay) && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Fonte operacional atrasada ou sem comunicação. Exibindo o último resumo recebido, do dia {formatDateBR(metrics.today.date)}, gerado às {formatTimeBR(metrics.generated_at)}. Estes valores não confirmam atividade atual.</div>}
    <section aria-label="Agora" className="rounded-xl border border-[var(--dc-border)] bg-white p-4 sm:p-5"><div className="flex flex-wrap justify-between gap-2"><h2 className="text-lg font-bold text-[var(--dc-navy)]"><span aria-hidden="true" className={liveFresh ? "text-emerald-600" : "text-slate-400"}>●</span> Agora</h2><span className="text-xs text-[var(--dc-text-muted)]">{liveFresh && live ? `Ao vivo · retrato das ${formatTimeBR(live.generated_at)}` : "Aguardando retrato operacional recente"}</span></div><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"><LiveTile label="Desenvolvedores online" value={liveFresh && live ? formatInt(live.developers.online) : "—"} detail={liveFresh && live ? `${live.developers.active} com requisição em andamento · janela de ${Math.round(live.window_s / 60)} min` : "Atividade não confirmada no último minuto"} /><LiveTile label="Slots em uso" value={busy === null ? "—" : `${Math.min(busy, metrics.slots)} de ${metrics.slots}`} detail={liveFresh && live ? `DevCore ${live.inflight.devcore} · outros ${live.inflight.other}${busy! > metrics.slots ? ` · ${busy! - metrics.slots} na fila` : ""}` : `${metrics.slots} slots configurados; ocupação não confirmada`} /><LiveTile label="GPU agora" value={liveFresh && live ? formatPercent(live.gpu.util, 0) : "—"} detail={liveFresh && live ? `VRAM ${formatGigabytes(live.gpu.mem_mb)} de ${formatGigabytes(live.gpu.mem_mb_total)}` : "Aguardando retrato recente"} /></div></section>
    <div className={!report.fresh ? "opacity-70" : undefined}><Indicators metrics={metrics} pseudonymous /><Charts metrics={metrics} vm={vm} /><TechnicalOpinion metrics={metrics} /></div>
    <p className="text-xs text-[var(--dc-text-muted)]">POD {pod.podId} · Métricas operacionais geradas às {formatTimeBR(metrics.generated_at)} (Brasília). Requisições = POST /v1/chat/completions; tempos consideram respostas bem-sucedidas. Identificadores de origem são pseudonimizados por POD.</p>
  </div>;
}
function LiveTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0 rounded-lg bg-[var(--dc-bg)] p-3 sm:p-4"><p className="text-[13px] font-bold text-[var(--dc-text-muted)]">{label}</p><p className="mt-1 text-3xl font-bold text-[var(--dc-navy)] dc-num">{value}</p><p className="mt-2 text-xs text-[var(--dc-text-muted)]">{detail}</p></div>;
}
