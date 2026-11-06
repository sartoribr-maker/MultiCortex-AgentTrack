"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Chart } from "./chart";
import { PocOperationalPanel } from "./poc-operational-panel";
import { summarizePods, type PocView } from "@/lib/devcore/poc-model";
import { combineGpuHistory, gpuDayStats } from "@/lib/devcore/poc-dashboard-model";
import { brasiliaDate, brasiliaMinutes, formatDateBR, formatTimeBR, pocProgress } from "@/lib/devcore/view";

const box = "rounded-xl border border-[var(--dc-border)] bg-white p-4 sm:p-5";
const soft = "min-w-0 rounded-lg bg-[var(--dc-bg)] p-3 sm:p-4";
const button = "rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2 text-sm font-bold text-[var(--dc-blue)] hover:border-[var(--dc-blue)] disabled:opacity-50";
const blue = "var(--dc-series-1)", orange = "var(--dc-series-2)";
const percent = (value: number | null) => value === null ? "—" : `${Math.round(value)}%`;
const memory = (value: number | null) => value === null ? "—" : `${(value / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GiB`;
const ticks = [0, 360, 720, 1080, 1440].map(value => ({ value, label: `${String(value / 60).padStart(2, "0")}h` }));
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="flex min-w-0 flex-col rounded-xl border border-[var(--dc-border)] bg-white p-3 sm:p-4"><span className="text-[13px] font-bold leading-tight text-[var(--dc-text-muted)]">{label}</span><span className="dc-num mt-1 text-2xl font-bold leading-tight text-[var(--dc-navy)] sm:text-[28px]">{value}</span><span className="mt-1 text-[13px] leading-snug text-[var(--dc-text-muted)]">{detail}</span></div>;
}
function PendingChart({ title, kind = "line", daily = false }: { title: string; kind?: "line" | "bar"; daily?: boolean }) {
  const latency = title.includes("resposta");
  return <Chart title={title} subtitle={daily ? "Período da POC · sem estimativas para dias não coletados" : "Últimas 24 horas"} kind={kind}
    x={[]} xDomain={[0, 23]} xTicks={[]} xLabels={[]}
    series={latency ? [{ key: "p50", label: "p50", color: blue, values: [] }, { key: "p95", label: "p95", color: orange, values: [] }] : [{ key: "pending", label: "Requisições", color: blue, values: [] }]}
    yFormat={value => latency ? `${value.toFixed(1)} s` : String(Math.round(value))} yMaxAtLeast={4} integer={!latency} height={220}
    emptyMessage="Aguardando coleta de requisições e tempos de resposta." />;
}
export function PocDetailDashboard({ poc, pocs, updatedAt, busy, onRefresh, onEdit, onAdd, onClose, children }: {
  poc: PocView; pocs: PocView[]; updatedAt: string; busy: boolean;
  onRefresh: () => void; onEdit: () => void; onAdd: () => void; onClose: () => void; children: ReactNode;
}) {
  const router = useRouter();
  const [podId, setPodId] = useState(poc.pods[0]?.id ?? "");
  const pods = podId ? poc.pods.filter(p => p.id === podId) : poc.pods;
  const summary = summarizePods(pods);
  const points = combineGpuHistory(pods);
  const history = gpuDayStats(points);
  const slots = pods.flatMap(p => p.servers).reduce((sum, server) => sum + (server.slots ?? 0), 0);
  const today = brasiliaDate(new Date(updatedAt));
  const progress = pocProgress(poc.startDate, poc.endDate, today);
  const progressPercent = progress.phase === "active" ? progress.day / progress.totalDays * 100 : progress.phase === "ended" ? 100 : 0;
  const phaseText = poc.status === "closed" ? "POC encerrada" : progress.phase === "before" ? `Começa em ${progress.startsIn} dias` : progress.phase === "ended" ? "Período previsto concluído" : `Dia ${progress.day} de ${progress.totalDays} · ${progress.remaining} dias restantes`;
  const latest = pods.map(p => p.receivedAt).filter((v): v is string => v !== null).sort().at(-1);
  const status = poc.status === "closed" ? "Encerrada" : summary.online === pods.length && pods.length > 0 ? "Online" : summary.online > 0 ? "Parcialmente online" : "Aguardando dados";
  const alerts = pods.flatMap(p => {
    const list: string[] = [];
    if (p.agent?.status === "approved" && !p.online) list.push(`${p.name}: sem comunicação recente. Verifique o agente e a conectividade.`);
    if (p.online) for (const gpu of p.devices) {
      if ((gpu.temperature ?? 0) >= 85) list.push(`${p.name}: ${gpu.name} a ${gpu.temperature} °C. Verifique refrigeração e carga.`);
      if (gpu.memoryTotal && gpu.memoryUsed !== null && gpu.memoryUsed / gpu.memoryTotal >= .95) list.push(`${p.name}: memória de ${gpu.name} acima de 95%. Avalie o uso de memória do modelo.`);
    }
    return list;
  });
  const remainingSlots = slots ? `de ${slots} configurados` : "Configuração ainda não recebida";
  return <div className="space-y-4">
    <section className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-wrap gap-3"><label className="flex min-w-0 flex-col gap-1 text-sm font-bold text-[var(--dc-text-muted)] sm:w-80">Empresa / POC<select aria-label="Empresa / POC" className="w-full rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2.5 text-base font-bold text-[var(--dc-navy)]" value={poc.id} onChange={e => router.push(`/pocs/${e.target.value}`)}>{pocs.map(p => <option key={p.id} value={p.id}>{p.client} · {p.name}</option>)}</select></label>{poc.pods.length > 1 && <label className="flex flex-col gap-1 text-sm font-bold text-[var(--dc-text-muted)]">POD<select aria-label="Filtrar POD no dashboard" value={podId} onChange={e => setPodId(e.target.value)} className="rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2.5 text-base"><option value="">Todas as PODs · infraestrutura</option>{poc.pods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</div>
      <div className="flex items-center gap-3 text-sm text-[var(--dc-text-muted)]"><span>Atualizado às {formatTimeBR(updatedAt)}</span><button className={button} disabled={busy} onClick={onRefresh}>Atualizar</button></div>
    </section>
    <section className={box}><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-bold text-[var(--dc-navy)] sm:text-3xl">{poc.client}</h1><h2 className="sr-only">{poc.name}</h2><p className="text-[var(--dc-text-muted)]">{poc.name} · {podId ? pods[0]?.name : `${pods.length} POD${pods.length === 1 ? "" : "s"}`} · {slots || "—"} slots configurados</p></div><span className={`rounded-full px-3 py-1 text-sm font-bold ${summary.online && poc.status === "active" ? "bg-[#e6f4ee] text-[#23704f]" : "bg-[#fdf3e8] text-[#8a4310]"}`}>● {status}</span></div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm"><span>Período: <strong>{formatDateBR(poc.startDate)} – {formatDateBR(poc.endDate)}</strong></span><span className="font-bold text-[var(--dc-purple)]">{phaseText}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--dc-grid)]" role="progressbar" aria-label="Progresso da POC" aria-valuenow={Math.round(progressPercent)} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-[var(--dc-purple)]" style={{ width: `${progressPercent}%` }} /></div><p className="mt-2 text-xs text-[var(--dc-text-muted)]">Dados de hoje ({formatDateBR(today)}), horário de Brasília.</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--dc-grid)] pt-3"><span className="text-xs text-[var(--dc-text-muted)]">Responsável: {poc.responsible}</span>{poc.status === "active" && <div className="flex flex-wrap gap-2"><button className={button} onClick={onEdit}>Editar POC</button><button className={button} onClick={onAdd}>+ Cadastrar POD</button><button className="px-2 text-sm font-bold text-rose-700 disabled:opacity-50" disabled={busy} onClick={onClose}>Encerrar POC</button></div>}</div>
      {poc.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--dc-text-muted)]">{poc.notes}</p>}{poc.status === "closed" && <p className="mt-3 text-sm text-[var(--dc-text-muted)]">Encerrada em {poc.closedAt ? new Date(poc.closedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}. Monitoramento revogado.</p>}
    </section>
    {pods.length === 1 && pods[0].operational?.metrics ? <PocOperationalPanel poc={poc} pod={pods[0]} updatedAt={updatedAt} /> : <>
    <section className={box} aria-label="Agora"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-bold text-[var(--dc-navy)]"><span aria-hidden="true" className={summary.online ? "text-emerald-600" : "text-slate-400"}>●</span> Agora</h2><p className="text-xs text-[var(--dc-text-muted)]">{latest ? `Última telemetria: ${formatTimeBR(latest)}` : "Aguardando a primeira telemetria"}</p></div><div className="mt-4 grid gap-3 md:grid-cols-3"><div className={soft}><p className="text-[13px] font-bold text-[var(--dc-text-muted)]">Desenvolvedores online</p><p className="mt-1 text-2xl font-bold text-[var(--dc-navy)]">—</p><p className="mt-2 text-xs text-[var(--dc-text-muted)]">Aguardando coleta de atividade e requisições</p></div><div className={soft}><p className="text-[13px] font-bold text-[var(--dc-text-muted)]">Slots em uso</p><p className="mt-1 text-2xl font-bold text-[var(--dc-navy)]">— <span className="text-lg">{remainingSlots}</span></p><p className="mt-2 text-xs text-[var(--dc-text-muted)]">O agente informa a configuração; ocupação ainda não coletada</p></div><div className={soft}><p className="text-[13px] font-bold text-[var(--dc-text-muted)]">GPU agora</p><p className="mt-1 text-2xl font-bold text-[var(--dc-navy)]">{percent(summary.gpuUtilization)}</p><p className="mt-2 text-xs text-[var(--dc-text-muted)]">{summary.online && summary.memoryTotal ? `VRAM ${memory(summary.memoryUsed)} de ${memory(summary.memoryTotal)}` : "Aguardando telemetria recente"}</p></div></div></section>
    <p className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">{pods.length > 1 ? "Selecione uma POD para visualizar os indicadores operacionais. A infraestrutura abaixo reúne as PODs selecionadas." : operationalProblem(pods[0]?.operationalProblem)} “—” significa dado não disponível.</p>
    <section aria-label="Indicadores de hoje" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric label="Requisições hoje" value="—" detail="Aguardando coleta de requisições" />
      <Metric label="Desenvolvedores ativos hoje" value="—" detail="Atividade por desenvolvedor ainda não coletada" />
      <Metric label="Tempo de resposta" value="—" detail="Mediana e p95 ainda não coletados" />
      <Metric label="Espera até o modelo responder" value="—" detail="Tempo até a primeira resposta ainda não coletado" />
      <Metric label="Taxa de erro (4xx/5xx)" value="—" detail="Respostas e cancelamentos ainda não coletados" />
      <Metric label="Pico de requisições simultâneas" value="—" detail="Concorrência de requisições ainda não coletada" />
      <Metric label={slots ? `Tempo com ≥ ${slots} requisições` : "Tempo com slots esgotados"} value="—" detail="Ocupação dos slots ainda não coletada" />
      <Metric label="Uso da GPU" value={percent(history.average)} detail={history.maximum !== null ? `média das amostras · máx. ${percent(history.maximum)} · VRAM máx. ${memory(history.memoryMax)}` : "Histórico começa com as próximas amostras recebidas"} />
    </section>
    <section aria-label="Gráficos" className="grid grid-cols-1 gap-4 lg:grid-cols-2"><PendingChart title="Requisições por hora" kind="bar" /><PendingChart title="Tempo de resposta por hora" />
      <PendingChart title="Requisições simultâneas hoje" />
      <div className="grid gap-4 sm:grid-cols-2"><Chart title="Uso da GPU hoje" subtitle="Média das amostras por POD a cada 5 minutos" kind="line" x={points.map(p => brasiliaMinutes(p.t))} xDomain={[0, 1440]} xTicks={ticks} xLabels={points.map(p => formatTimeBR(p.t))} series={[{ key: "gpu", label: "Uso da GPU", color: blue, values: points.map(p => p.utilization) }]} yFormat={value => `${Math.round(value)}%`} yMaxFixed={100} gapAbove={10} height={220} emptyMessage="Aguardando as primeiras amostras de GPU de hoje." /><Chart title="VRAM hoje" subtitle="Soma dos máximos por POD a cada 5 minutos" kind="line" x={points.map(p => brasiliaMinutes(p.t))} xDomain={[0, 1440]} xTicks={ticks} xLabels={points.map(p => formatTimeBR(p.t))} series={[{ key: "vram", label: "VRAM", color: blue, values: points.map(p => p.memoryUsed === null ? null : p.memoryUsed / 1024) }]} yFormat={value => `${Math.round(value)} GiB`} yMaxAtLeast={summary.memoryTotal / 1024 || 1} gapAbove={10} height={220} emptyMessage="Aguardando as primeiras amostras de memória de hoje." /></div>
      <PendingChart title="POC inteira: requisições por dia" kind="bar" daily /><PendingChart title="POC inteira: tempo de resposta p95 por dia" daily />
    </section>
    <section className={box}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold text-[var(--dc-navy)]">Parecer técnico</h2><p className="text-sm text-[var(--dc-text-muted)]">Gerado a partir de comunicação e GPU, às {formatTimeBR(updatedAt)}.</p></div><span className={`rounded-full px-2 py-1 text-xs font-bold ${alerts.length ? "bg-[#fdf3e8] text-[#8a4310]" : "bg-slate-100 text-slate-600"}`}>{alerts.length ? "Observar" : "Parecer parcial"}</span></div>
      <p className="mt-3 font-bold">{alerts.length ? `${alerts.length} ponto(s) para observar nos dados disponíveis.` : summary.online ? "Nenhum alerta nos dados recentes de GPU e comunicação." : "Aguardando telemetria recente para avaliar GPU e comunicação."}</p><h3 className="mt-4 text-sm font-bold text-[var(--dc-navy)]">Observações identificadas</h3><ul className="mt-2 divide-y divide-[var(--dc-border)] border-y border-[var(--dc-border)]">{alerts.map((alert, i) => <li key={i} className="py-3 text-sm">{alert}</li>)}<li className="py-3 text-sm"><strong>Parecer parcial</strong><p className="mt-1 text-[var(--dc-text-muted)]">Não há uma fonte operacional válida para esta seleção de PODs. Não é possível concluir sobre capacidade ou gargalos de atendimento com esses dados.</p></li></ul>
      <div className="mt-4 grid gap-5 md:grid-cols-2"><div><h3 className="text-sm font-bold text-[var(--dc-navy)]">Ajustes de configuração</h3><p className="mt-2 text-sm text-[var(--dc-text-muted)]">Verificar a fonte operacional do agente ou selecionar uma POD para avaliar o comportamento do modelo.</p></div><div><h3 className="text-sm font-bold text-[var(--dc-navy)]">Upgrades de infraestrutura</h3><p className="mt-2 text-sm text-[var(--dc-text-muted)]">Sem recomendação automática de upgrade nesta etapa; faltam indicadores de demanda e resposta.</p></div></div>
    </section>
    </>}
    <details className={box}><summary className="cursor-pointer text-sm font-bold text-[var(--dc-navy)]">PODs da POC · detalhes e autorização ({poc.pods.length})</summary><div className="mt-4 space-y-4">{children}</div></details>
    <p className="text-xs text-[var(--dc-text-muted)]">Agente Universal · Último recebimento: {latest ? new Date(latest).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"} (Brasília). Histórico de GPU registrado no Monitor a partir desta atualização; intervalos sem amostras permanecem em branco.</p>
  </div>;
}

function operationalProblem(reason?: string | null) {
  const messages: Record<string, string> = {
    source_not_configured: "Configure uma fonte local de métricas ou a captura no template.",
    tcpdump_unavailable: "A captura foi solicitada, mas tcpdump não está disponível na imagem.",
    server_selection_required: "Selecione explicitamente a porta do servidor monitorado no template.",
    hosts_required: "Configure os hosts do gateway DevCore para classificar as requisições.",
    source_identity_mismatch: "A fonte local não corresponde ao host ou aos slots da POD.",
    source_stale: "A fonte operacional parou de atualizar. Verifique o coletor local.",
    collection_failed: "A coleta operacional encontrou erro. Confira os logs do agente.",
    capture_warming_up: "Captura iniciando; aguardando o primeiro retrato operacional.",
    capture_unavailable: "A captura não está disponível. Confira as permissões da imagem.",
    http_not_observed: "Aguardando o primeiro tráfego HTTP observado na porta do modelo. Tráfego TLS exige outra fonte de métricas.",
    approval_required: "Autorize o monitoramento para iniciar a coleta operacional.",
  };
  return messages[reason ?? ""] ?? "Aguardando resumo operacional do agente. Confira a versão e a configuração da fonte.";
}
