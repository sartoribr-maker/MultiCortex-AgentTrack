"use client";

import { BASE_PATH } from "@/lib/base-path";

import { useCallback, useEffect, useState } from "react";

type Agent = {
  id: string;
  podId: string | null;
  hostname: string | null;
  version: string;
  status: "pending" | "approved" | "revoked";
  createdAt: string;
  updatedAt: string;
};

type Metrics = {
  agent: Agent;
  telemetry: {
    receivedAt?: string;
    metrics?: {
      gpu?: unknown;
      llama?: unknown;
      fallback?: boolean;
    };
  } | null;
  online: boolean;
};

const statusLabel: Record<Agent["status"], string> = {
  pending: "Aguardando aprovação",
  approved: "Aprovado",
  revoked: "Revogado",
};

export function UniversalAgentsPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(BASE_PATH + "/api/devcore/agents", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Não foi possível consultar os agentes.");
      }

      const data = await response.json();
      const items: Agent[] = Array.isArray(data)
        ? data
        : Array.isArray(data.agents)
          ? data.agents
          : [];

      setAgents(items);

      const results = await Promise.all(
        items.map(async (agent) => {
          try {
            const result = await fetch(
              BASE_PATH + "/api/devcore/agents/" +
                encodeURIComponent(agent.id) +
                "/metrics",
              { cache: "no-store" }
            );

            if (!result.ok) return null;

            return [agent.id, await result.json()] as const;
          } catch {
            return null;
          }
        })
      );

      const next: Record<string, Metrics> = {};

      for (const result of results) {
        if (result) next[result[0]] = result[1];
      }

      setMetrics(next);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erro ao atualizar agentes."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);

    const timer = setInterval(() => {
      void refresh();
    }, 10000);

    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);

  async function changeStatus(
    agent: Agent,
    action: "approve" | "revoke"
  ) {
    const message =
      action === "approve"
        ? "Aprovar o monitoramento deste agente?"
        : "Revogar o acesso deste agente?";

    if (!window.confirm(message)) return;

    setBusy(agent.id);
    setError(null);

    try {
      const response = await fetch(
        BASE_PATH + "/api/devcore/agents/" +
          encodeURIComponent(agent.id) +
          "/" +
          action,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      );

      if (!response.ok) {
        throw new Error("Não foi possível alterar o status do agente.");
      }

      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erro administrativo."
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      aria-label="Agentes universais"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800">
            Agentes Universais
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            RunPod, GPUs e servidores de inferência
          </p>
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
        >
          Atualizar agentes
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading && (
        <p className="text-sm text-slate-500">Carregando agentes...</p>
      )}

      {!loading && agents.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
          <p className="font-semibold text-slate-700">
            Nenhum Agente Universal cadastrado
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Os agentes aparecerão aqui após o cadastro automático.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {agents.map((agent) => {
          const detail = metrics[agent.id];
          const snapshot = detail?.telemetry;

          return (
            <article
              key={agent.id}
              className="rounded-xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-slate-800">
                    {agent.podId || agent.hostname || agent.id}
                  </h3>

                  <p className="mt-1 break-all text-xs text-slate-500">
                    ID: {agent.id}
                  </p>

                  <p className="mt-1 text-xs text-slate-500">
                    Versão: {agent.version}
                  </p>
                </div>

                <span className={
                  "rounded-full px-3 py-1 text-xs font-bold " +
                  (agent.status === "approved"
                    ? "bg-green-100 text-green-800"
                    : agent.status === "pending"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-red-100 text-red-800")
                }>
                  {statusLabel[agent.status]}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {agent.status !== "approved" &&
                  agent.status !== "revoked" && (
                    <button
                      type="button"
                      disabled={busy === agent.id}
                      onClick={() => void changeStatus(agent, "approve")}
                      className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Aprovar
                    </button>
                  )}

                {agent.status === "approved" && (
                  <button
                    type="button"
                    disabled={busy === agent.id}
                    onClick={() => void changeStatus(agent, "revoke")}
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    Revogar
                  </button>
                )}
              </div>

              {agent.status === "approved" && (
                <div className="mt-4 rounded-lg bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-700">
                    Telemetria: {detail?.online ? "Recente" : "Sem dados recentes"}
                  </p>

                  {snapshot?.receivedAt && (
                    <p className="mt-1 text-xs text-slate-500">
                      Último recebimento: {new Date(
                        snapshot.receivedAt
                      ).toLocaleString("pt-BR")}
                    </p>
                  )}

                  {snapshot?.metrics && (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="mb-1 text-sm font-semibold">
                          GPU
                        </p>
                        <pre className="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-white">
                          {JSON.stringify(snapshot.metrics.gpu ?? null, null, 2)}
                        </pre>
                      </div>

                      <div>
                        <p className="mb-1 text-sm font-semibold">
                          llama.cpp
                        </p>
                        <pre className="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-white">
                          {JSON.stringify(snapshot.metrics.llama ?? null, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
