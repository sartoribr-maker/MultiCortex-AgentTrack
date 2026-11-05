import { useMemo } from "react";
import { assessMetrics, type Recommendation, type Severity } from "@/lib/devcore/assessment";
import type { DevcoreMetrics } from "@/lib/devcore/metrics-schema";
import { formatTimeBR } from "@/lib/devcore/view";

const SEVERITY_STYLE: Record<Severity | "ok", { label: string; icon: string; cls: string }> = {
  alert: { label: "Atenção", icon: "▲", cls: "bg-[#fdecef] text-[#a3122f]" },
  warn: { label: "Observar", icon: "●", cls: "bg-[#fdf3e8] text-[#8a4310]" },
  info: { label: "Informação", icon: "i", cls: "bg-[var(--dc-grid)] text-[var(--dc-text-muted)]" },
  ok: { label: "Saudável", icon: "✓", cls: "bg-[#e6f4ee] text-[#23704f]" },
};

function SeverityPill({ severity }: { severity: Severity | "ok" }) {
  const style = SEVERITY_STYLE[severity];
  return (
    <span className={`inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${style.cls}`}>
      <span aria-hidden>{style.icon}</span>{style.label}
    </span>
  );
}

function RecommendationList({ title, items }: { title: string; items: Recommendation[] }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-bold text-[var(--dc-navy)]">{title}</h3>
      {items.length ? (
        <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-sm">
          {items.map((item) => (
            <li key={item.id}>
              {item.text}
              <span className="mt-0.5 block text-xs text-[var(--dc-text-muted)]">Resolve: {item.addresses.join(" · ")}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-[var(--dc-text-muted)]">Nenhum necessário hoje.</p>
      )}
    </div>
  );
}

export function TechnicalOpinion({ metrics }: { metrics: DevcoreMetrics }) {
  const assessment = useMemo(() => assessMetrics(metrics), [metrics]);
  return (
    <section aria-labelledby="dc-opinion" className="mt-4 rounded-xl border border-[var(--dc-border)] bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dc-opinion" className="text-lg font-bold text-[var(--dc-navy)]">Parecer técnico</h2>
          <p className="text-sm text-[var(--dc-text-muted)]">
            Gerado automaticamente a partir dos indicadores de hoje, às {formatTimeBR(metrics.generated_at)}.
          </p>
        </div>
        <SeverityPill severity={assessment.verdict} />
      </div>
      <p className="mt-3 font-bold">{assessment.summary}</p>

      {assessment.findings.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-bold text-[var(--dc-navy)]">Problemas identificados</h3>
          <ul className="mt-2 flex flex-col divide-y divide-[var(--dc-border)] border-y border-[var(--dc-border)]">
            {assessment.findings.map((finding) => (
              <li key={finding.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-3">
                <div className="sm:w-28 sm:shrink-0 sm:pt-0.5"><SeverityPill severity={finding.severity} /></div>
                <div className="min-w-0">
                  <p className="font-bold">{finding.title}</p>
                  <p className="dc-num text-sm text-[var(--dc-text-muted)]">{finding.evidence}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {(assessment.adjustments.length > 0 || assessment.upgrades.length > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          <RecommendationList title="Ajustes de configuração" items={assessment.adjustments} />
          <RecommendationList title="Upgrades de infraestrutura" items={assessment.upgrades} />
        </div>
      )}
    </section>
  );
}
