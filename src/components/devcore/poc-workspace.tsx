"use client";

import Link from "next/link";
import { PocDetailDashboard } from "./poc-detail-dashboard";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { summarizePods, operationalCoverage, type PocOverview, type PocView, type PublicAgent, type PodView, type PocInput } from "@/lib/devcore/poc-model";

const button = "inline-flex items-center justify-center rounded-lg bg-[var(--dc-navy)] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[var(--dc-blue)] disabled:opacity-50";
const secondary = "inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100";
const panel = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6";
const pct = (value: number | null) => value === null ? "—" : `${Math.round(value)}%`;
const gib = (value: number) => (value / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const date = (value: string) => new Date(value + "T12:00:00Z").toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
const time = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Ainda não recebida";
function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "green" | "amber" | "red" | "slate" }) {
  const styles = { green: "bg-emerald-50 text-emerald-800", amber: "bg-amber-50 text-amber-900", red: "bg-rose-50 text-rose-800", slate: "bg-slate-100 text-slate-600" };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${styles[tone]}`}>{children}</span>;
}
function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <div className={panel}><p className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 text-3xl font-bold text-[var(--dc-navy)] dc-num">{value}</p>{detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}</div>;
}
function Meter({ value }: { value: number | null }) {
  return <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden><div className={`h-full rounded-full ${value !== null && value >= 95 ? "bg-orange-500" : "bg-[var(--dc-blue)]"}`} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></div>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={title} className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border-0 bg-white p-6 text-slate-800 shadow-2xl backdrop:bg-slate-900/50">
    <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-xl font-bold">{title}</h2><button type="button" onClick={onClose} aria-label="Fechar formulário" className={secondary}>Fechar</button></div>{children}</dialog>;
}
function PocForm({ poc, onSubmit, busy }: { poc?: PocView; onSubmit: (input: PocInput) => void; busy: boolean }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    onSubmit(Object.fromEntries(["name", "client", "responsible", "startDate", "endDate", "notes"].map(key => [key, String(data.get(key) ?? "")])) as PocInput);
  }
  return <form onSubmit={submit} className="space-y-4">
    <Field label="Nome da POC"><input name="name" required maxLength={120} defaultValue={poc?.name} className={input} placeholder="Ex.: Assistente de atendimento" /></Field>
    <Field label="Cliente"><input name="client" required maxLength={120} defaultValue={poc?.client} className={input} placeholder="Nome da empresa" /></Field>
    <Field label="Responsável"><input name="responsible" required maxLength={160} defaultValue={poc?.responsible} className={input} placeholder="Nome ou e-mail" /></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Início"><input name="startDate" type="date" required defaultValue={poc?.startDate ?? today} className={input} /></Field><Field label="Encerramento previsto"><input name="endDate" type="date" required defaultValue={poc?.endDate ?? today} className={input} /></Field></div>
    <Field label="Observações"><textarea name="notes" maxLength={2000} defaultValue={poc?.notes} className={input} rows={3} /></Field>
    <button disabled={busy} className={button}>{busy ? "Salvando…" : poc ? "Salvar alterações" : "Criar POC"}</button>
  </form>;
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block space-y-1.5 text-sm font-bold text-slate-700"><span>{label}</span>{children}</label>; }

export function PocWorkspace({ pocId }: { pocId?: string }) {
  const [data, setData] = useState<PocOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"pocs" | "agents">("pocs");
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [pocModal, setPocModal] = useState<"new" | "edit" | null>(null);
  const [podModal, setPodModal] = useState<{ pocId: string; agent?: PublicAgent } | null>(null);
  const [podAgent, setPodAgent] = useState("");
  const [destination, setDestination] = useState("");
  const [formError, setFormError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    try {
      const response = await fetch(BASE_PATH + "/api/devcore/pocs", { cache: "no-store", signal });
      if (response.status === 401) { window.location.assign(BASE_PATH + "/entrar"); return; }
      if (!response.ok) throw new Error(response.status === 403 ? "Seu usuário não possui acesso administrativo." : "Não foi possível atualizar os dados.");
      const result: PocOverview = await response.json();
      if (!signal?.aborted && request === sequence.current) { setData(result); setError(""); }
    } catch (cause) { if (!signal?.aborted && request === sequence.current) setError(cause instanceof Error ? cause.message : "Falha de comunicação"); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const initial = setTimeout(() => void refresh(controller.signal), 0);
    const timer = setInterval(() => void refresh(controller.signal), 10000);
    return () => { clearTimeout(initial); clearInterval(timer); controller.abort(); };
  }, [refresh]);
  async function mutate(path: string, method: string, payload: unknown = {}) {
    setBusy(true); setFormError("");
    try {
      const response = await fetch(BASE_PATH + "/api/devcore/" + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (response.status === 401) { window.location.assign(BASE_PATH + "/entrar"); return false; }
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Operação não concluída"); }
      await refresh(); return true;
    } catch (cause) { const message = cause instanceof Error ? cause.message : "Operação não concluída"; setFormError(message); setError(message); return false; }
    finally { setBusy(false); }
  }
  const pocs = data?.pocs ?? [];
  const selected = pocs.find(p => p.id === pocId);
  const active = pocs.filter(p => p.status === "active");
  const allPods = active.flatMap(p => p.pods);
  const summary = summarizePods(selected ? selected.pods : allPods);
  const unassigned = data?.unassignedAgents ?? [];
  const coverage = operationalCoverage(allPods);
  function openPod(id: string, agent?: PublicAgent) {
    setFormError(""); setDestination(id); setPodAgent(agent?.id ?? ""); setPodModal({ pocId: id, agent });
  }
  async function authorization(agent: PublicAgent, action: "approve" | "revoke" | "reset-credential") {
    if (action === "reset-credential") {
      const reason = window.prompt("Informe o motivo da recuperação administrativa (mínimo 10 caracteres). Não informe tokens.");
      if (!reason || !window.confirm("Esta ação reaprova o agente e invalida sua credencial anterior. Use somente para reativação ou perda confirmada de credencial. Confirmar?")) return;
      await mutate(`agents/${agent.id}/reset-credential`, "POST", { reason });
      return;
    }
    if (!window.confirm(action === "approve" ? "Autorizar a coleta e telemetria desta POD?" : "Revogar o monitoramento? O agente excluirá sua credencial e será necessária recuperação administrativa para reativá-lo.")) return;
    await mutate(`agents/${agent.id}/${action}`, "POST");
  }
  if (!data) return <div className="mx-auto max-w-7xl px-4 py-12"><h1 className="text-2xl font-bold">Central de POCs</h1><p role={error ? "alert" : "status"} className="mt-4">{error || "Carregando ambiente…"}</p><button onClick={() => void refresh()} className={secondary + " mt-4"}>Atualizar</button></div>;
  if (pocId && !selected) return <div className="mx-auto max-w-7xl p-8"><h1 className="text-2xl font-bold">POC não encontrada</h1><Link href="/" className={secondary + " mt-4"}>Voltar à central</Link></div>;
  const listed = pocs.filter(p => (filter === "all" || p.status === filter) && `${p.name} ${p.client}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const candidates = podModal?.agent ? [podModal.agent] : unassigned.filter(a => a.podId);
  const agentChosen = candidates.find(a => a.id === podAgent);
  return <div className="mx-auto max-w-7xl space-y-6 px-4 py-7 sm:px-6 lg:px-8">
    {selected && <Link href="/" className="text-sm font-bold text-[var(--dc-blue)] hover:underline">← Central de POCs</Link>}
    {!selected && <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[var(--dc-orange)]">DevCore Monitor · Operação</p><h1 className="mt-2 text-3xl font-bold text-[var(--dc-navy)]">Central de POCs</h1><p className="mt-2 text-sm text-slate-500">Acompanhe os clientes, autorize as PODs e monitore cada operação.</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void refresh()} className={secondary}>Atualizar</button><button onClick={() => { setFormError(""); setPocModal("new"); }} className={button}>+ Nova POC</button></div></div>}
    {error && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error} Os dados exibidos podem estar desatualizados.</div>}
    {!selected && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Stat label="POCs ativas" value={active.length} detail={`${allPods.length} PODs vinculadas · ${summary.online} online`} />
      <Stat label="Utilização das GPUs" value={pct(summary.gpuUtilization)} detail={`${summary.gpuCount} GPUs com telemetria recente`} />
      <Stat label="Memória das GPUs" value={summary.memoryTotal ? `${gib(summary.memoryUsed)} GiB` : "—"} detail={summary.memoryTotal ? `de ${gib(summary.memoryTotal)} GiB de capacidade total` : "Aguardando telemetria recente"} />
      <Stat label="Requisições hoje" value={coverage.requests === null ? "—" : `${coverage.requests.toLocaleString("pt-BR")}${coverage.complete ? "" : "+"}`} detail="Requisições observadas nas fontes operacionais recentes" />
      <Stat label="Fontes operacionais" value={`${coverage.covered} / ${coverage.total}`} detail="PODs aprovadas com resumo operacional recente" />
      <Stat label="PODs pendentes" value={summary.pending + unassigned.length} detail={`${unassigned.length} agentes aguardando vinculação`} />
    </div>}
    {selected ? <PocDetailDashboard key={selected.id} poc={selected} pocs={pocs} updatedAt={data.updatedAt} busy={busy}
      onRefresh={() => void refresh()} onEdit={() => { setFormError(""); setPocModal("edit"); }} onAdd={() => openPod(selected.id)}
      onClose={() => { if (window.confirm("Encerrar esta POC? O monitoramento de todas as PODs vinculadas será revogado. Esta ação não pode ser desfeita por esta tela.")) void mutate(`pocs/${selected.id}/close`, "POST"); }}>
      {selected.pods.length === 0 && <Empty title="Cadastre a primeira POD desta POC" detail="Informe o ID da RunPod ou vincule um agente que já se registrou. A autorização é feita após a vinculação." />}
      {selected.pods.map(pod => <PodCard key={pod.id} pod={pod} closed={selected.status === "closed"} busy={busy} onAuthorize={authorization} candidate={unassigned.find(a => a.podId === pod.podId)} onBind={agent => void mutate(`pocs/${selected.id}/pods/${pod.id}`, "PATCH", { agentId: agent.id })} />)}
    </PocDetailDashboard> : <>
      <nav aria-label="Visões da operação" className="flex gap-6 border-b border-slate-200"><button aria-pressed={tab === "pocs"} onClick={() => setTab("pocs")} className={`border-b-2 px-1 pb-3 text-sm font-bold ${tab === "pocs" ? "border-[var(--dc-orange)] text-[var(--dc-navy)]" : "border-transparent text-slate-500"}`}>POCs</button><button aria-pressed={tab === "agents"} onClick={() => setTab("agents")} className={`border-b-2 px-1 pb-3 text-sm font-bold ${tab === "agents" ? "border-[var(--dc-orange)] text-[var(--dc-navy)]" : "border-transparent text-slate-500"}`}>PODs e autorizações <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{unassigned.length}</span></button></nav>
      {tab === "pocs" ? <>
        <div className="flex flex-wrap gap-3"><input aria-label="Buscar POC ou cliente" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar POC ou cliente…" className={input + " sm:max-w-sm"} /><select aria-label="Filtrar situação" value={filter} onChange={e => setFilter(e.target.value)} className={input + " sm:max-w-48"}><option value="active">POCs ativas</option><option value="closed">Encerradas</option><option value="all">Todas as POCs</option></select></div>
        {!listed.length && <Empty title={pocs.length ? "Nenhuma POC neste filtro" : "Sua operação começa por uma POC"} detail={pocs.length ? "Altere a busca ou a situação para encontrar uma POC." : "Cadastre o cliente e o período, vincule as PODs e autorize o monitoramento."} />}
        <div className="grid gap-5 lg:grid-cols-2">{listed.map(poc => {
          const s = summarizePods(poc.pods);
          const c = operationalCoverage(poc.pods);
          const health = poc.status === "closed" ? "Encerrada" : s.attention ? "Atenção" : s.online ? "Operando" : "Aguardando dados";
          return <Link key={poc.id} href={`/pocs/${poc.id}`} className={panel + " group block transition hover:border-blue-300 hover:shadow-md"}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-slate-500">{poc.client}</p><h2 className="mt-1 text-xl font-bold text-[var(--dc-navy)] group-hover:text-blue-800">{poc.name}</h2></div><Badge tone={poc.status === "closed" ? "slate" : s.attention ? "amber" : s.online ? "green" : "slate"}>{health}</Badge></div><p className="mt-2 text-xs text-slate-500">{date(poc.startDate)} → {date(poc.endDate)}</p><div className="mt-5 grid grid-cols-3 gap-3 border-t border-slate-100 pt-4"><div><p className="text-xs text-slate-500">PODs online</p><p className="mt-1 text-lg font-bold">{s.online}<span className="text-sm font-normal text-slate-400"> / {s.total}</span></p></div><div><p className="text-xs text-slate-500">Uso de GPU</p><p className="mt-1 text-lg font-bold">{pct(s.gpuUtilization)}</p></div><div><p className="text-xs text-slate-500">Memória GPU</p><p className="mt-1 text-lg font-bold">{s.memoryTotal ? `${Math.round(s.memoryUsed / s.memoryTotal * 100)}%` : "—"}</p></div></div><p className="mt-3 text-xs text-slate-500">Requisições hoje: <strong>{c.requests === null ? "—" : `${c.requests.toLocaleString("pt-BR")}${c.complete ? "" : "+"}`}</strong> · {c.covered}/{c.total} fontes operacionais</p><div className="mt-4 flex justify-between text-xs text-slate-500"><span>{s.pending ? `${s.pending} POD(s) aguardando autorização ou agente` : poc.responsible}</span><span className="font-bold text-[var(--dc-blue)]">Abrir POC →</span></div></Link>;
        })}</div>
      </> : <section className={panel}><h2 className="text-lg font-bold text-[var(--dc-navy)]">Agentes aguardando vinculação</h2><p className="mt-1 text-sm text-slate-500">Vincule cada POD à POC correspondente antes de autorizar o monitoramento.</p>{!unassigned.length && <p className="mt-6 text-sm text-slate-500">Todos os agentes registrados estão vinculados a uma POC.</p>}<div className="mt-4 divide-y divide-slate-100">{unassigned.map(agent => <div key={agent.id} className="flex flex-wrap items-center justify-between gap-4 py-4"><div><p className="font-bold">{agent.podId || agent.hostname || "POD não identificada"}</p><p className="mt-1 break-all text-xs text-slate-500">{agent.id}</p><div className="mt-2"><Badge tone={agent.status === "approved" ? "green" : agent.status === "revoked" ? "red" : "amber"}>{agent.status === "approved" ? "Aprovado anteriormente · vinculação pendente" : agent.status === "revoked" ? "Revogado" : "Aguardando vinculação e aprovação"}</Badge></div></div><button disabled={busy || !active.length || !agent.podId} className={secondary} onClick={() => openPod(active[0]?.id ?? "", agent)}>Vincular a uma POC</button></div>)}</div>{!active.length && <p className="mt-4 text-sm text-amber-800">Crie uma POC ativa para vincular as PODs.</p>}</section>}
    </>}
    <p className="text-right text-xs text-slate-400">Atualização automática a cada 10 s · Última consulta: {time(data.updatedAt)} · Horário de Brasília</p>
    {pocModal && <Modal title={pocModal === "edit" ? "Editar POC" : "Nova POC"} onClose={() => { if (!busy) setPocModal(null); }}>{formError && <p role="alert" className="mb-4 text-sm text-red-700">{formError}</p>}<PocForm poc={pocModal === "edit" ? selected : undefined} busy={busy} onSubmit={async input => { if (await mutate(pocModal === "edit" ? `pocs/${selected!.id}` : "pocs", pocModal === "edit" ? "PATCH" : "POST", input)) setPocModal(null); }} /></Modal>}
    {podModal && <Modal title={podModal.agent ? "Vincular POD à POC" : "Cadastrar POD"} onClose={() => { if (!busy) setPodModal(null); }}>{formError && <p role="alert" className="mb-4 text-sm text-red-700">{formError}</p>}<form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      if (await mutate(`pocs/${destination}/pods`, "POST", { name: fields.get("name"), podId: fields.get("podId"), agentId: podAgent || null })) setPodModal(null);
    }}><Field label="POC"><select aria-label="POC" className={input} value={destination} onChange={e => setDestination(e.target.value)} required>{active.map(p => <option key={p.id} value={p.id}>{p.client} · {p.name}</option>)}</select></Field><Field label="Agente registrado"><select aria-label="Agente registrado" className={input} value={podAgent} onChange={e => setPodAgent(e.target.value)} disabled={!!podModal.agent}><option value="">Cadastrar POD antes de instalar o agente</option>{candidates.map(a => <option value={a.id} key={a.id}>{a.podId || a.hostname} · {a.status}</option>)}</select></Field><Field label="ID da POD na RunPod"><input key={podAgent} name="podId" className={input} required maxLength={128} defaultValue={agentChosen?.podId ?? ""} readOnly={!!agentChosen} placeholder="Ex.: 25ymgt2hq5zout" /></Field><Field label="Nome da POD"><input name="name" className={input} required maxLength={120} placeholder="Ex.: Inferência · H200 · Modelo de atendimento" /></Field><p className="text-xs text-slate-500">Vincular a POD não autoriza a coleta. A autorização é feita no painel da POC.</p><button className={button} disabled={busy}>{busy ? "Salvando…" : "Salvar POD"}</button></form></Modal>}
  </div>;
}
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center"><h2 className="text-lg font-bold text-[var(--dc-navy)]">{title}</h2><p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">{detail}</p></div>; }
function PodCard({ pod, closed, busy, candidate, onBind, onAuthorize }: { pod: PodView; closed: boolean; busy: boolean; candidate?: PublicAgent; onBind: (agent: PublicAgent) => void; onAuthorize: (agent: PublicAgent, action: "approve" | "revoke" | "reset-credential") => void }) {
  const agent = pod.agent;
  const label = closed ? "POC encerrada" : !agent ? "Aguardando agente" : agent.status === "pending" ? "Aguardando aprovação" : agent.status === "revoked" ? "Revogado" : pod.online ? "Online" : "Sem comunicação recente";
  return <article className={panel}><div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-lg font-bold text-[var(--dc-navy)]">{pod.name}</h3><p className="mt-1 text-xs text-slate-500">POD {pod.podId} {agent ? `· Agente ${agent.version}` : ""}</p></div><div className="flex flex-wrap items-center gap-3"><Badge tone={pod.online ? "green" : agent?.status === "pending" ? "amber" : "slate"}>{label}</Badge>{!closed && agent?.status === "pending" && <button disabled={busy} onClick={() => onAuthorize(agent, "approve")} className={button}>Autorizar monitoramento</button>}{!closed && agent?.status === "approved" && <button disabled={busy} onClick={() => onAuthorize(agent, "revoke")} className="text-sm font-bold text-rose-700 disabled:opacity-50">Revogar</button>}{!closed && agent && (agent.status === "revoked" || (agent.status === "approved" && !pod.online)) && <button disabled={busy} onClick={() => onAuthorize(agent, "reset-credential")} className={secondary}>{agent.status === "revoked" ? "Reativar monitoramento" : "Recuperar credencial"}</button>}{!closed && !agent && candidate && <button disabled={busy} onClick={() => onBind(candidate)} className={button}>Vincular agente encontrado</button>}</div></div>
    <p className="mt-3 text-xs text-slate-500">Última telemetria: {time(pod.receivedAt)}{pod.receivedAt && !pod.online ? " · Amostra histórica, sem confirmação de atividade atual" : ""}</p>
    {!pod.receivedAt ? <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-500">{agent?.status === "pending" ? "Aguardando autorização para iniciar a coleta." : "Aguardando a primeira telemetria da POD."}</p> : <>
      <div className="mt-5 grid gap-4 xl:grid-cols-2">{pod.devices.map((gpu, index) => <div key={index} className="rounded-xl border border-slate-200 p-4"><div className="flex justify-between gap-3"><h4 className="font-bold text-slate-800">{gpu.name}</h4><span className="text-xs text-slate-500">GPU {gpu.index ?? index}</span></div><div className="mt-4 grid grid-cols-3 gap-3"><div><p className="text-xs text-slate-500">Utilização</p><p className="mt-1 text-xl font-bold">{pct(gpu.utilization)}</p><Meter value={gpu.utilization} /></div><div><p className="text-xs text-slate-500">Memória</p><p className="mt-1 text-xl font-bold">{gpu.memoryUsed === null ? "—" : gib(gpu.memoryUsed)} <span className="text-xs font-normal">GiB</span></p><p className="mt-1 text-xs text-slate-500">de {gpu.memoryTotal === null ? "—" : gib(gpu.memoryTotal)} GiB</p></div><div><p className="text-xs text-slate-500">Temperatura</p><p className="mt-1 text-xl font-bold">{gpu.temperature === null ? "—" : `${gpu.temperature} °C`}</p></div></div></div>)}</div>
      {!pod.devices.length && <p className="mt-4 text-sm text-slate-500">Nenhuma GPU informada nesta amostra.</p>}
      <div className="mt-5 overflow-x-auto"><h4 className="mb-2 text-sm font-bold text-slate-700">Servidores llama.cpp</h4>{pod.servers.length ? <table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-xs text-slate-500"><tr><th className="py-2">Processo</th><th>PID</th><th>Porta</th><th>Slots configurados</th></tr></thead><tbody>{pod.servers.map((server, i) => <tr key={i} className="border-b border-slate-100"><td className="py-3 pr-4">{server.executable}</td><td>{server.pid ?? "—"}</td><td>{server.port ?? "—"}</td><td>{server.slots ?? "—"}</td></tr>)}</tbody></table> : <p className="text-sm text-slate-500">Nenhum servidor detectado nesta amostra.</p>}</div>
    </>}
  </article>;
}
