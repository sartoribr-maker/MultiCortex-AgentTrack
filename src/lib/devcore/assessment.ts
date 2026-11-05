import type { DevcoreMetrics } from "./metrics-schema";
import { formatDuration, formatGigabytes, formatInt, formatPercent } from "./view";

export type Severity = "alert" | "warn" | "info";

export type Finding = {
  id: string;
  severity: Severity;
  title: string;
  evidence: string;
};

export type Recommendation = {
  id: string;
  text: string;
  /** Titles of the findings this recommendation addresses. */
  addresses: string[];
};

export type Assessment = {
  verdict: "ok" | "warn" | "alert";
  summary: string;
  findings: Finding[];
  /** Configuration changes, no new hardware. */
  adjustments: Recommendation[];
  /** Changes that need new hardware or another VM. */
  upgrades: Recommendation[];
};

const SEVERITY_ORDER: Record<Severity, number> = { alert: 0, warn: 1, info: 2 };

const tps = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} tokens/s`;
const tokens = (value: number) => `${formatInt(Math.round(value))} tokens`;
const pct = (part: number, total: number) => formatPercent(total ? (part / total) * 100 : 0);

/**
 * Rule-based technical opinion over today's indicators: problems found, the
 * evidence behind each one, and the adjustments and upgrades that address them.
 */
export function assessMetrics(metrics: DevcoreMetrics): Assessment {
  const t = metrics.today;
  const server = t.server;
  const slots = metrics.slots;
  const ctx = server?.ctx_per_slot ?? null;
  const peak = t.inflight?.peak.total ?? null;
  const considered = t.requests - t.cancelled_499;
  const memTotal = t.gpu.mem_mb_total;
  const memRatio = memTotal && t.gpu.mem_mb_max != null ? t.gpu.mem_mb_max / memTotal : null;

  const catalog: Record<string, { kind: "adjust" | "upgrade"; text: string }> = {
    "client-context": {
      kind: "adjust",
      text: ctx
        ? `Limitar o contexto no cliente DevCore (terminal e extensão) a cerca de ${tokens(Math.floor((ctx * 0.85) / 1000) * 1000)}, para ele compactar o histórico antes de enviar em vez de receber 400.`
        : "Limitar o contexto no cliente DevCore (terminal e extensão) abaixo do limite por slot, para ele compactar o histórico antes de enviar.",
    },
    "kv-quant": {
      kind: "adjust",
      text: "Quantizar o cache KV em q8_0 no llama.cpp (--cache-type-k q8_0 --cache-type-v q8_0, com flash attention): a memória do contexto cai pela metade e o contexto por slot pode quase dobrar na mesma GPU.",
    },
    "fewer-slots": {
      kind: "adjust",
      text: ctx && peak != null
        ? `Reduzir os slots de ${slots} para ${Math.floor(slots / 2)} (--parallel): cada um passa a ter cerca de ${tokens(ctx * 2)}. O pico de hoje (${formatInt(peak)} simultâneas) caberia.`
        : `Reduzir os slots (--parallel) para aumentar o contexto de cada um.`,
    },
    "lighter-quant": {
      kind: "adjust",
      text: "Trocar o modelo Q8_0 por Q6_K ou Q5_K_M: cerca de 20% a 35% menos dados lidos da VRAM por token, o que acelera a geração e libera memória para contexto. Validar a qualidade das respostas antes.",
    },
    "client-concurrency": {
      kind: "adjust",
      text: "Limitar as chamadas em paralelo por desenvolvedor no cliente (subagentes e tarefas simultâneas), para os picos caberem nos slots.",
    },
    "separate-other": {
      kind: "adjust",
      text: "Tirar deste servidor o tráfego que não é DevCore (mesmo gateway), para ele não disputar os slots.",
    },
    "investigate-5xx": {
      kind: "adjust",
      text: "Verificar o journal do multicortex-server nos horários das falhas (falta de memória, reinícios, exceções).",
    },
    "update-agent": {
      kind: "adjust",
      text: "Atualizar o agente da VM para a versão 1.2, que lê o log do servidor e informa o motivo de cada erro, o contexto usado e a velocidade de geração.",
    },
    "check-sampler": {
      kind: "adjust",
      text: "Verificar o coletor de amostras de GPU da VM (samples.csv): sem ele, uso de GPU e VRAM ficam sem dados.",
    },
    "second-node": {
      kind: "upgrade",
      text: "Segunda GPU ou VM com balanceamento entre as duas: dobra os slots para os picos e reduz o número de gerações dividindo a mesma GPU.",
    },
    "gpu-bigger": {
      kind: "upgrade",
      text: "GPU com mais VRAM e maior largura de banda de memória (classe 80 GB): mais contexto por slot sem reduzir slots e geração mais rápida.",
    },
  };

  const findings: (Finding & { actions: string[] })[] = [];
  const add = (finding: Finding, actions: string[]) => findings.push({ ...finding, actions });

  // 1. Context: requests larger than one slot's context are rejected with 400.
  if (server && server.context_exceeded > 0) {
    const share = t.requests ? (server.context_exceeded / t.requests) * 100 : 0;
    const used = server.context_tokens.p95 != null && server.context_tokens.p50 != null
      ? ` As atendidas usaram ${tokens(server.context_tokens.p50)} na mediana e ${tokens(server.context_tokens.p95)} no p95.`
      : "";
    add({
      id: "context",
      severity: share >= 5 ? "alert" : "warn",
      title: "Contexto acima do limite por slot",
      evidence: `${formatInt(server.context_exceeded)} de ${formatInt(t.requests)} requisições (${formatPercent(share)}) recusadas com HTTP 400: pediam até ${tokens(server.context_exceeded_max_tokens ?? 0)}${ctx ? `, e cada slot aceita ${tokens(ctx)}` : ""}.${used} Acontece tanto no terminal quanto na extensão, sempre que o histórico enviado passa do limite.`,
    }, [
      "client-context",
      "kv-quant",
      ...(peak != null && peak <= slots / 2 ? ["fewer-slots"] : []),
      "gpu-bigger",
    ]);
  } else if (server && ctx && server.context_tokens.p95 != null && server.context_tokens.p95 >= ctx * 0.85) {
    add({
      id: "context",
      severity: "warn",
      title: "Contexto perto do limite por slot",
      evidence: `5% das requisições usaram mais de ${tokens(server.context_tokens.p95)}, perto do limite de ${tokens(ctx)} por slot. Sessões mais longas vão começar a receber 400.`,
    }, ["client-context", "kv-quant"]);
  } else if (!server && considered > 0 && t.errors_4xx / considered >= 0.01) {
    add({
      id: "context",
      severity: "warn",
      title: "Requisições recusadas (4xx)",
      evidence: `${formatInt(t.errors_4xx)} requisições (${pct(t.errors_4xx, considered)}) voltaram com erro 4xx. No llama.cpp, 400 em /v1/chat/completions costuma ser contexto acima do limite do slot. O agente desta VM ainda não envia o motivo.`,
    }, ["update-agent", "client-context"]);
  }

  // 2. Server failures.
  const otherErrors = server?.errors_other ?? 0;
  if (t.errors_5xx > 0 || otherErrors > 0) {
    const rate = considered ? t.errors_5xx / considered : 0;
    const parts = [
      t.errors_5xx > 0 ? `${formatInt(t.errors_5xx)} respostas 5xx (${formatPercent(rate * 100)})` : null,
      otherErrors > 0 ? `${formatInt(otherErrors)} erros no log do servidor além dos de contexto` : null,
    ].filter(Boolean);
    add({
      id: "server-errors",
      severity: rate >= 0.01 ? "alert" : "warn",
      title: "Falhas do servidor do modelo",
      evidence: `${parts.join(" e ")} hoje.`,
    }, ["investigate-5xx"]);
  }

  // 3. Queue: more concurrent requests than slots.
  if (t.inflight && peak != null) {
    const saturation = t.inflight.saturation_pct.total;
    if (saturation > 0 || peak > slots) {
      const other = t.inflight.peak.other;
      const gpuAvg = t.gpu.util_avg;
      add({
        id: "queue",
        severity: saturation >= 10 ? "alert" : "warn",
        title: "Fila nos horários de pico",
        evidence: [
          `Pico de ${formatInt(peak)} requisições simultâneas para ${slots} slots${peak > slots ? `: ${formatInt(peak - slots)} esperaram na fila` : ""}.`,
          `Todos os slots ficaram ocupados em ${formatPercent(saturation)} do dia até agora.`,
          other > 0 ? `Tráfego de outros sistemas no mesmo gateway chegou a ${formatInt(other)} simultâneas.` : null,
          gpuAvg != null && gpuAvg < 50 ? `A GPU teve ${formatPercent(gpuAvg, 0)} de uso médio: o gargalo são os picos, não a carga média.` : null,
        ].filter(Boolean).join(" "),
      }, ["client-concurrency", ...(other > 0 ? ["separate-other"] : []), "second-node"]);
    }
  }

  // 4. Waiting for the first token (queue + prompt processing).
  const ttfb95 = t.ttfb_s.p95;
  if (ttfb95 != null && ttfb95 >= 10) {
    add({
      id: "ttfb",
      severity: ttfb95 >= 30 ? "alert" : "warn",
      title: "Espera longa até a primeira resposta",
      evidence: `Mediana de ${formatDuration(t.ttfb_s.p50)} e p95 de ${formatDuration(ttfb95)} até o modelo começar a responder.${server?.prefill_tps_p50 != null ? ` O prompt é processado a ${tps(server.prefill_tps_p50)}, então prompts grandes e a fila somam espera.` : ""}`,
    }, ["client-context", "client-concurrency", "second-node"]);
  }

  // 5. Generation speed (tokens per second for each request).
  const decode = server?.decode_tps.p50 ?? null;
  if (decode != null && decode < 20) {
    const p10 = server?.decode_tps.p10;
    add({
      id: "decode",
      severity: decode < 10 ? "alert" : "warn",
      title: "Geração de texto lenta",
      evidence: `Mediana de ${tps(decode)} por requisição${p10 != null ? ` (as 10% mais lentas abaixo de ${tps(p10)})` : ""}: uma resposta de 500 tokens leva cerca de ${formatDuration(500 / decode)}. Tempo total p95 de ${formatDuration(t.latency_s.p95)}. Com ${slots} gerações dividindo a mesma GPU, a largura de banda de memória limita a velocidade.`,
    }, ["lighter-quant", "second-node", "gpu-bigger"]);
  } else if (!server && t.latency_s.p95 != null && t.latency_s.p95 >= 120) {
    add({
      id: "decode",
      severity: "warn",
      title: "Tempo de resposta alto",
      evidence: `p95 de ${formatDuration(t.latency_s.p95)} por requisição (mediana ${formatDuration(t.latency_s.p50)}).`,
    }, ["update-agent", "lighter-quant"]);
  }

  // 6. VRAM headroom.
  if (memRatio != null && memRatio >= 0.9) {
    add({
      id: "vram",
      severity: memRatio >= 0.97 ? "alert" : "warn",
      title: "VRAM quase cheia",
      evidence: `${formatGigabytes(t.gpu.mem_mb_max)} de ${formatGigabytes(memTotal)} ocupados (${formatPercent(memRatio * 100, 0)}). Aumentar contexto ou slots exige liberar memória antes.`,
    }, ["kv-quant", "lighter-quant", "gpu-bigger"]);
  }

  // 7. Users giving up.
  if (t.requests >= 20 && t.cancelled_499 / t.requests >= 0.1) {
    add({
      id: "cancelled",
      severity: "warn",
      title: "Muitas requisições canceladas",
      evidence: `${formatInt(t.cancelled_499)} de ${formatInt(t.requests)} (${pct(t.cancelled_499, t.requests)}) foram canceladas antes do fim, o que costuma acompanhar espera ou geração lentas.`,
    }, []);
  }

  // 8. Missing data.
  if (!server && !findings.some((f) => f.id === "context")) {
    add({
      id: "agent",
      severity: "info",
      title: "Parecer parcial",
      evidence: "O agente desta VM não envia o log do servidor do modelo: motivo dos erros, contexto e velocidade de geração ficam fora desta análise.",
    }, ["update-agent"]);
  }
  if (t.samples === 0) {
    add({
      id: "samples",
      severity: "info",
      title: "Sem amostras de GPU hoje",
      evidence: "Uso de GPU e VRAM não puderam ser avaliados.",
    }, ["check-sampler"]);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const recommendations = new Map<string, Recommendation & { kind: "adjust" | "upgrade" }>();
  for (const finding of findings) {
    for (const id of finding.actions) {
      const existing = recommendations.get(id);
      if (existing) existing.addresses.push(finding.title);
      else recommendations.set(id, { id, ...catalog[id], addresses: [finding.title] });
    }
  }
  const pick = (kind: "adjust" | "upgrade") =>
    [...recommendations.values()].filter((r) => r.kind === kind).map(({ id, text, addresses }) => ({ id, text, addresses }));

  const alerts = findings.filter((f) => f.severity === "alert").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const verdict = alerts ? "alert" : warns ? "warn" : "ok";
  const summary = verdict === "ok"
    ? "Nenhum problema relevante nos indicadores de hoje."
    : [
      alerts ? `${alerts} ${alerts === 1 ? "ponto de atenção" : "pontos de atenção"}` : null,
      warns ? `${warns} ${warns === 1 ? "ponto para observar" : "pontos para observar"}` : null,
    ].filter(Boolean).join(" e ") + " nos indicadores de hoje.";

  return {
    verdict,
    summary,
    findings: findings.map(({ id, severity, title, evidence }) => ({ id, severity, title, evidence })),
    adjustments: pick("adjust"),
    upgrades: pick("upgrade"),
  };
}
