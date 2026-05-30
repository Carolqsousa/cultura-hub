"use client";

import { useEffect, useState, useMemo } from "react";

interface KPI {
  total_leads: number; vendas: number; perdidos: number;
  em_andamento: number; pausados: number; agendados: number;
  compareceram: number; taxa_conversao: number; taxa_descarte: number;
  taxa_agendamento: number; taxa_comparecimento: number;
  tmv_medio: number; total_late_tasks: number;
}
interface StageRow { stage: string; total: number; vendas: number; perdidos: number; em_andamento: number; conversao: number; }
interface ResponsibleRow { responsible: string; total: number; vendas: number; perdidos: number; em_andamento: number; agendados: number; compareceram: number; conversao: number; taxa_agend: number; tmv_medio: number; }
interface SourceRow { source: string; total: number; vendas: number; conversao: number; }
interface TempRow { temperature: string; total: number; vendas: number; conversao: number; }
interface LossRow { loss_reason: string; total: number; }
interface MonthRow { month: string; total: number; vendas: number; perdidos: number; conversao: number; tmv_medio: number; }
interface LateTaskRow { responsible: string; late_tasks: number; avg_days_late: number; max_days_late: number; very_late: number; }

const STAGE_ORDER = ["Sala de Espera","Interesse","Nivelamento","Experiência CI / Aula","Proposta enviada","Negociação","Pausados","Finalização","Exames"];
const TEMP_COLOR: Record<string, string> = { "Quente": "#e74c3c", "Morno": "#f39c12", "Frio": "#3498db", "Desconhecido": "#95a5a6" };

export default function ComercialPage() {
  const [kpi, setKpi] = useState<KPI | null>(null);
  const [byStage, setByStage] = useState<StageRow[]>([]);
  const [byResponsible, setByResponsible] = useState<ResponsibleRow[]>([]);
  const [bySource, setBySource] = useState<SourceRow[]>([]);
  const [byTemperature, setByTemperature] = useState<TempRow[]>([]);
  const [lossReasons, setLossReasons] = useState<LossRow[]>([]);
  const [monthlyVolume, setMonthlyVolume] = useState<MonthRow[]>([]);
  const [lateTasks, setLateTasks] = useState<LateTaskRow[]>([]);
  const [filterOptions, setFilterOptions] = useState<{ responsibles: string[]; units: string[] }>({ responsibles: [], units: [] });
  const [loading, setLoading] = useState(true);

  const [filterResp, setFilterResp] = useState("all");
  const [filterUnit, setFilterUnit] = useState("all");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  function buildUrl() {
    const p = new URLSearchParams();
    if (filterResp !== "all") p.set("responsible", filterResp);
    if (filterUnit !== "all") p.set("unit", filterUnit);
    if (filterFrom) p.set("from", filterFrom);
    if (filterTo) p.set("to", filterTo);
    return `/api/comercial?${p.toString()}`;
  }

  function loadData() {
    setLoading(true);
    fetch(buildUrl())
      .then(r => r.json())
      .then(d => {
        setKpi(d.kpi); setByStage(d.byStage || []); setByResponsible(d.byResponsible || []);
        setBySource(d.bySource || []); setByTemperature(d.byTemperature || []);
        setLossReasons(d.lossReasons || []); setMonthlyVolume(d.monthlyVolume || []);
        setLateTasks(d.lateTasks || []);
        if (d.filters) setFilterOptions(d.filters);
        setLoading(false);
      }).catch(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, []);

  const stagesSorted = useMemo(() => [...byStage].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage), bi = STAGE_ORDER.indexOf(b.stage);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  }), [byStage]);

  const responsiblesSorted = useMemo(() => {
    return [...byResponsible].map(r => ({
      ...r,
      score: r.total > 0
        ? Math.round((Number(r.conversao) / Math.max(...byResponsible.map(x => Number(x.conversao)), 1) * 50)
          + (Number(r.total) / Math.max(...byResponsible.map(x => Number(x.total)), 1) * 50))
        : 0
    })).sort((a, b) => b.score - a.score);
  }, [byResponsible]);

  const maxMonth = useMemo(() => Math.max(...monthlyVolume.map(r => Number(r.total)), 1), [monthlyVolume]);
  const maxSource = useMemo(() => Math.max(...bySource.map(r => Number(r.total)), 1), [bySource]);
  const maxLoss = useMemo(() => Math.max(...lossReasons.map(r => Number(r.total)), 1), [lossReasons]);

  function scoreLabel(s: number) {
    if (s >= 70) return { label: "🌟 Destaque", color: "#1D9E75" };
    if (s >= 50) return { label: "✅ Sólido", color: "#3498db" };
    if (s >= 35) return { label: "⚠️ Atenção", color: "#f39c12" };
    return { label: "🚨 Crítico", color: "#e74c3c" };
  }

  function fmtMonth(m: string) {
    try {
      return new Date(m + "-01").toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    } catch { return m; }
  }

  if (loading) return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Comercial</h1>
      <p className="text-sm text-gray-400 mt-4">Carregando dados...</p>
    </main>
  );

  return (
    <main className="p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Comercial</h1>
          <p className="text-sm text-gray-500">Funil RD Station CRM — análise completa</p>
        </div>
        {/* Filters */}
        <div className="flex gap-2 flex-wrap items-center">
          <select value={filterUnit} onChange={e => setFilterUnit(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl shadow-sm px-3 py-1.5 bg-white text-gray-700 outline-none">
            <option value="all">Todas as unidades</option>
            {filterOptions.units.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={filterResp} onChange={e => setFilterResp(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl shadow-sm px-3 py-1.5 bg-white text-gray-700 outline-none">
            <option value="all">Todos os atendentes</option>
            {filterOptions.responsibles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl shadow-sm px-3 py-1.5 bg-white text-gray-700 outline-none" />
          <span className="text-gray-400 text-sm">até</span>
          <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl shadow-sm px-3 py-1.5 bg-white text-gray-700 outline-none" />
          <button onClick={loadData}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 transition-colors">
            Aplicar
          </button>
          <button onClick={() => { setFilterResp("all"); setFilterUnit("all"); setFilterFrom(""); setFilterTo(""); setTimeout(loadData, 0); }}
            className="text-sm border border-gray-200 text-gray-500 px-3 py-1.5 rounded-lg hover:bg-gray-50">
            Limpar
          </button>
        </div>
      </div>

      {/* KPI Row 1 */}
      <div className="grid grid-cols-4 gap-4 mb-4">
        <KPICard label="Total de leads" value={Number(kpi?.total_leads).toLocaleString("pt-BR")} color="text-blue-600" />
        <KPICard label="Vendas realizadas" value={Number(kpi?.vendas).toLocaleString("pt-BR")} color="text-green-600" />
        <KPICard label="Em andamento" value={Number(kpi?.em_andamento).toLocaleString("pt-BR")} color="text-orange-500" />
        <KPICard label="Leads perdidos" value={Number(kpi?.perdidos).toLocaleString("pt-BR")} color="text-red-500" />
      </div>

      {/* KPI Row 2 */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <KPICard label="Taxa de conversão" value={`${kpi?.taxa_conversao ?? 0}%`} color="text-green-600" sub={`${kpi?.vendas} de ${kpi?.total_leads}`} />
        <KPICard label="Taxa de agendamento" value={`${kpi?.taxa_agendamento ?? 0}%`} color="text-blue-600" sub={`${kpi?.agendados} agendados`} />
        <KPICard label="TMV médio" value={kpi?.tmv_medio ? `${Math.round(Number(kpi.tmv_medio))} dias` : "—"} color="text-purple-600" sub="tempo médio até venda" />
        <KPICard label="Tarefas atrasadas" value={String(kpi?.total_late_tasks ?? 0)} color={(kpi?.total_late_tasks ?? 0) > 0 ? "text-red-500" : "text-green-600"} />
      </div>

      {/* Funnel + Monthly Volume */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card title="Leads por fase do funil">
          {stagesSorted.map((r, i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium truncate max-w-[200px]">{r.stage}</span>
                <div className="flex gap-3 shrink-0 ml-2">
                  <span className="text-gray-500">{Number(r.total)}</span>
                  <span className="text-green-600 font-medium">{r.conversao}%</span>
                </div>
              </div>
              <div className="flex gap-1 h-2">
                <div className="bg-green-500 rounded-l" style={{ width: `${Number(r.vendas) / Math.max(Number(r.total), 1) * 100}%` }} />
                <div className="bg-orange-300" style={{ width: `${Number(r.em_andamento) / Math.max(Number(r.total), 1) * 100}%` }} />
                <div className="bg-red-300 rounded-r flex-1" />
              </div>
            </div>
          ))}
          <div className="flex gap-4 mt-3 text-xs text-gray-400">
            <span><span className="inline-block w-2 h-2 bg-green-500 rounded-sm mr-1" />Vendas</span>
            <span><span className="inline-block w-2 h-2 bg-orange-300 rounded-sm mr-1" />Em andamento</span>
            <span><span className="inline-block w-2 h-2 bg-red-300 rounded-sm mr-1" />Perdidos</span>
          </div>
        </Card>

        <Card title="Volume mensal — últimos 12 meses">
          {monthlyVolume.map((r, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-gray-700">{fmtMonth(r.month)}</span>
                <div className="flex gap-3">
                  <span className="text-gray-500">{Number(r.total)} leads</span>
                  <span className="text-green-600">{Number(r.vendas)} vendas</span>
                  <span className="text-blue-600 font-medium">{r.conversao}%</span>
                </div>
              </div>
              <div className="flex gap-0.5 h-1.5">
                <div className="bg-green-500 rounded-l" style={{ width: `${Number(r.vendas) / maxMonth * 100}%` }} />
                <div className="bg-blue-200 rounded-r flex-1" style={{ width: `${(Number(r.total) - Number(r.vendas)) / maxMonth * 100}%` }} />
              </div>
            </div>
          ))}
        </Card>
      </div>

      {/* Source + Temperature */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card title="Volume de leads por fonte">
          {bySource.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
          {bySource.map((r, i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium truncate max-w-[200px]">{r.source || "Desconhecido"}</span>
                <div className="flex gap-3 shrink-0">
                  <span className="text-gray-500">{Number(r.total)}</span>
                  <span className="text-green-600 font-medium">{r.conversao}%</span>
                </div>
              </div>
              <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${Number(r.total) / maxSource * 100}%` }} />
              </div>
            </div>
          ))}
        </Card>

        <Card title="Temperatura do lead">
          {byTemperature.map((r, i) => (
            <div key={i} className="flex items-center gap-3 mb-3">
              <span className="text-sm font-medium w-28 shrink-0">{r.temperature}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-2">
                <div className="h-2 rounded-full" style={{
                  width: `${Number(r.total) / Math.max(...byTemperature.map(x => Number(x.total)), 1) * 100}%`,
                  background: TEMP_COLOR[r.temperature] || "#95a5a6"
                }} />
              </div>
              <span className="text-sm text-gray-500 w-8 text-right">{Number(r.total)}</span>
              <span className="text-xs font-medium w-12 text-right" style={{ color: TEMP_COLOR[r.temperature] || "#95a5a6" }}>
                {r.conversao}%
              </span>
            </div>
          ))}
        </Card>
      </div>

      {/* Loss Reasons */}
      <Card title="Ranking de motivos de perda">
        {lossReasons.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
        <div className="grid grid-cols-2 gap-x-8">
          {lossReasons.map((r, i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium truncate max-w-[240px]">{r.loss_reason}</span>
                <span className="text-red-500 font-medium ml-2 shrink-0">{Number(r.total)}</span>
              </div>
              <div className="bg-gray-100 rounded-full h-1.5">
                <div className="h-1.5 rounded-full bg-red-400" style={{ width: `${Number(r.total) / maxLoss * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Responsible Performance */}
      <Card title="Performance por atendente — Score combinado (50% conversão + 50% volume)">
        {responsiblesSorted.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b">
              <th className="pb-2">Atendente</th>
              <th className="pb-2 text-center">Total</th>
              <th className="pb-2 text-center">Vendas</th>
              <th className="pb-2 text-center">Perdidos</th>
              <th className="pb-2 text-center">Agendados</th>
              <th className="pb-2 text-center">Conversão</th>
              <th className="pb-2 text-center">TMV</th>
              <th className="pb-2 text-center">Score</th>
              <th className="pb-2">Perfil</th>
            </tr>
          </thead>
          <tbody>
            {responsiblesSorted.map((r, i) => {
              const { label, color } = scoreLabel(r.score);
              return (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 font-medium">{r.responsible}</td>
                  <td className="py-2 text-center text-gray-600">{Number(r.total)}</td>
                  <td className="py-2 text-center text-green-600 font-medium">{Number(r.vendas)}</td>
                  <td className="py-2 text-center text-red-400">{Number(r.perdidos)}</td>
                  <td className="py-2 text-center text-blue-500">{Number(r.agendados)}</td>
                  <td className="py-2 text-center font-medium" style={{ color: Number(r.conversao) >= 20 ? "#1D9E75" : Number(r.conversao) >= 10 ? "#BA7517" : "#A32D2D" }}>
                    {r.conversao}%
                  </td>
                  <td className="py-2 text-center text-gray-500">
                    {r.tmv_medio ? `${Math.round(Number(r.tmv_medio))}d` : "—"}
                  </td>
                  <td className="py-2 text-center">
                    <span className="font-bold text-base" style={{ color }}>{r.score}</span>
                  </td>
                  <td className="py-2">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: color + "20", color }}>{label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* Late Tasks */}
      <Card title="Tarefas atrasadas por atendente">
        {lateTasks.length === 0
          ? <p className="text-sm text-green-600 font-medium">✓ Nenhuma tarefa atrasada</p>
          : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b">
                  <th className="pb-2">Atendente</th>
                  <th className="pb-2 text-center">Atrasadas</th>
                  <th className="pb-2 text-center">Muito atrasadas (+7d)</th>
                  <th className="pb-2 text-center">Média dias</th>
                  <th className="pb-2 text-center">Máx. dias</th>
                </tr>
              </thead>
              <tbody>
                {lateTasks.map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 font-medium">{r.responsible}</td>
                    <td className="py-2 text-center text-red-500 font-medium">{Number(r.late_tasks)}</td>
                    <td className="py-2 text-center text-red-700 font-medium">{Number(r.very_late)}</td>
                    <td className="py-2 text-center text-orange-500">{Number(r.avg_days_late)}</td>
                    <td className="py-2 text-center text-red-600 font-medium">{Number(r.max_days_late)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Card>
    </main>
  );
}

function KPICard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">{title}</h2>
      {children}
    </div>
  );
}
