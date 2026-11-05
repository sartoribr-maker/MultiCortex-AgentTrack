"use client";

import { useEffect, useRef } from "react";
import type { DevcoreDeveloper } from "@/lib/devcore/metrics-schema";
import { formatActiveTime, formatDateBR, formatDuration, formatInt, formatPercent, formatTimeBR, isRecentlyActive } from "@/lib/devcore/view";

type Props = {
  developers: DevcoreDeveloper[];
  date: string;
  generatedAt: string;
  open: boolean;
  onClose: () => void;
};

/** Today's usage per developer IP, opened from the "Desenvolvedores ativos hoje" card. */
export function DevelopersDialog({ developers, date, generatedAt, open, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(); // click on the backdrop
      }}
      aria-labelledby="dc-devs-title"
      className="m-auto w-[calc(100%-2rem)] max-w-5xl rounded-xl border border-[var(--dc-border)] bg-white p-0 text-[var(--dc-text)] backdrop:bg-black/40"
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--dc-border)] p-4 sm:p-5">
        <div className="min-w-0">
          <h2 id="dc-devs-title" className="text-lg font-bold text-[var(--dc-navy)]">
            Desenvolvedores ativos hoje ({formatDateBR(date)})
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--dc-text-muted)]">
            Um por IP de origem. Vários desenvolvedores atrás do mesmo NAT aparecem como um. Dados até {formatTimeBR(generatedAt)} (Brasília).
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg border border-[var(--dc-border)] px-3 py-1.5 text-sm font-bold text-[var(--dc-blue)] hover:border-[var(--dc-blue)]"
        >
          Fechar
        </button>
      </div>
      {developers.length === 0 ? (
        <p className="p-5 text-[var(--dc-text-muted)]">Nenhum desenvolvedor com chamada bem-sucedida hoje.</p>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="dc-num w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 bg-white text-left text-[13px] text-[var(--dc-text-muted)]">
              <tr className="border-b border-[var(--dc-border)]">
                <th scope="col" className="px-4 py-2 font-bold">Desenvolvedor (IP)</th>
                <th scope="col" className="px-3 py-2 font-bold">Período</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">Tempo ativo</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">Inferências</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">Erros</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">Canceladas</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">Resposta p50</th>
                <th scope="col" className="px-4 py-2 text-right font-bold">Espera p50</th>
              </tr>
            </thead>
            <tbody>
              {developers.map((dev) => {
                const errors = dev.errors_4xx + dev.errors_5xx;
                const considered = dev.requests - dev.cancelled_499;
                const errorPct = considered ? (errors / considered) * 100 : 0;
                return (
                  <tr key={dev.ip} className="border-b border-[var(--dc-grid)] last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-bold text-[var(--dc-navy)]">{dev.ip}</span>
                      {isRecentlyActive(dev.last_seen, generatedAt) && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[#e6f4ee] px-2 py-0.5 text-xs font-bold text-[#23704f]">
                          <span aria-hidden>●</span>ativo agora
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">{formatTimeBR(dev.first_seen)}–{formatTimeBR(dev.last_seen)}</td>
                    <td className="px-3 py-2.5 text-right">{formatActiveTime(dev.active_s)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="font-bold">{formatInt(dev.requests)}</span>
                      <span className="block text-xs text-[var(--dc-text-muted)]">{formatInt(dev.requests_ok)} com sucesso</span>
                    </td>
                    <td className={`px-3 py-2.5 text-right ${errorPct >= 5 ? "font-bold text-[#a3122f]" : ""}`}>
                      {formatInt(errors)}
                      {errors > 0 && (
                        <span className="block text-xs font-normal text-[var(--dc-text-muted)]">
                          {formatPercent(errorPct)} · 4xx {formatInt(dev.errors_4xx)} · 5xx {formatInt(dev.errors_5xx)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">{formatInt(dev.cancelled_499)}</td>
                    <td className="px-3 py-2.5 text-right">{formatDuration(dev.latency_p50)}</td>
                    <td className="px-4 py-2.5 text-right">{formatDuration(dev.ttfb_p50)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-[var(--dc-border)] px-4 py-3 text-xs text-[var(--dc-text-muted)] sm:px-5">
        Inferências = POST /v1/chat/completions. Tempo ativo soma os períodos de uso, juntando chamadas com até 5 min de intervalo.
        Erros = 4xx/5xx (canceladas pelo cliente ficam à parte). Tempos de resposta e espera consideram só respostas 2xx.
      </p>
    </dialog>
  );
}
