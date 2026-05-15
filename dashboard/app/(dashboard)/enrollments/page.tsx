"use client";

import { useEffect, useState } from "react";

interface KPI {
  total_leads: number;
  vendas: number;
  perdidos: number;
  em_andamento: number;
  pausados: number;
  taxa_conversao: number;
  taxa_descarte: number;
  tmv_medio: number;
  total_late_tasks: number;
}

interface StageRow {
  stage: string;
  total: number;
  vendas: number;
  conversao: number;
}

interface ResponsibleRow {
  responsible: string;
  total: number;
  vendas: number;
  perdidos: number;
  em_andamento: number;
  conversao: number;
}

interface LateTaskRow {
  responsible: string;
  late_tasks: number;
  avg_days_late: number;
  max_days_late: number;
}

interface MonthRow {
  month: string;
  total: number;
  vendas: number;
  conversao: number;
}

const STAGE_ORDER = [
  "Sala de Espera",
  "Interesse",
  "Nivelamento",
  "Experiência CI / Aula",
  "Proposta enviada",
  "Negociação",
  "Pausados",
  "Finalização",
  "Exames",
];

export default function LeadsPage() {
  const [kpi, setKpi] = useState<KPI | null>(null);
  const [byStage, setByStage] = useState<StageRow[]>([]);
  const [byResponsible, setByResponsible] = useState<ResponsibleRow[]>([]);
  const [lateTasks, setLateTasks] = useState<LateTaskRow[]>([]);
  const [monthlyVolume, setMonthlyVolume] = useState<MonthRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/leads")
      .then(r => r.json())
      .then(d => {
        setKpi(d.kpi);
        setByStage(d.byStage || []);
        setByResponsible(d.byResponsible || []);
        setLateTasks(d.lateTasks || []);
        setMonthlyVolume(d.monthlyVolume || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Comercial</h1>
      <p className="text-sm text-gray-400 mt-4">Carregando dados...</p>
    </main>
  );

  const stagesSorted = [...byStage].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage);
    const bi = STAGE_ORDER.indexOf(b.stage);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const maxStageTotal = Math.max(...stagesSorted.map(r => Number(r.total)), 1);
  const maxMonthTotal = Math.max(...monthlyVolume.map(r => Number(r.total)), 1);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Comercial</h1>
      <p className="text-sm text-gray-500 mb-8">Funil RD Station CRM — visão geral</p>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <MetricCard label="Total de leads" value={Number(kpi?.total_leads).toLocaleString("pt-BR")} color="text-blue-600" />
        <MetricCard label="Vendas realizadas" value={Number(kpi?.vendas).toLocaleString("pt-BR")} color="text-green-600" />
        <MetricCard label="Em andamento" value={Number(kpi?.em_andamento).toLocaleString("pt-BR")} color="text-orange-500" />
        <MetricCard label="Leads perdidos" value={Number(kpi?.perdidos).toLocaleString("pt-BR")} color="text-red-500" />
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <MetricCard label="Taxa de conversão" value={`${kpi?.taxa_conversao ?? 0}%`} color="text-green-600" />
        <MetricCard label="Taxa de descarte" value={`${kpi?.taxa_descarte ?? 0}%`} color="text-red-500" />
        <MetricCard label="TMV médio" value={kpi?.tmv_medio ? `${kpi.tmv_medio} dias` : "—"} color="text-blue-600" />
        <MetricCard label="Tarefas atrasadas" value={String(kpi?.total_late_tasks ?? 0)} color={(kpi?.total_late_tasks ?? 0) > 0 ? "text-red-500" : "text-green-600"} />
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">

        {/* Funnel stages */}
        <Card title="Leads por fase do funil">
          {stagesSorted.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
          {stagesSorted.map((r, i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium truncate max-w-[180px]">{r.stage}</span>
                <span className="text-gray-500 ml-2 shrink-0">{Number(r.total)} leads</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-gray-100 rounded-full h-2">
                  <div
                    className="h-2 rounded-full bg-blue-500"
                    style={{ width: `${Math.round(Number(r.total) / maxStageTotal * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-green-600 font-medium w-12 text-right">{r.conversao}% conv.</span>
              </div>
            </div>
          ))}
        </Card>

        {/* Monthly volume */}
        <Card title="Volume mensal (últimos 6 meses)">
          {monthlyVolume.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
          {monthlyVolume.map((r, i) => {
            const month = r.month ? new Date(r.month + "-01").toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }) : r.month;
            return (
              <div key={i} className="mb-3">
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-medium">{month}</span>
                  <span className="text-gray-500">{Number(r.total)} leads · {Number(r.vendas)} vendas</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-gray-100 rounded-full h-2 relative">
                    <div className="h-2 rounded-full bg-blue-200" style={{ width: `${Math.round(Number(r.total) / maxMonthTotal * 100)}%` }} />
                    <div
                      className="h-2 rounded-full bg-green-500 absolute top-0 left-0"
                      style={{ width: `${Math.round(Number(r.vendas) / maxMonthTotal * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-green-600 font-medium w-12 text-right">{r.conversao}%</span>
                </div>
              </div>
            );
          })}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">

        {/* Performance by responsible */}
        <Card title="Performance por responsável">
          {byResponsible.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="pb-2">Responsável</th>
                <th className="pb-2 text-center">Total</th>
                <th className="pb-2 text-center">Vendas</th>
                <th className="pb-2 text-center">Perdidos</th>
                <th className="pb-2 text-center">Conversão</th>
              </tr>
            </thead>
            <tbody>
              {byResponsible.map((r, i) => {
                const conv = Number(r.conversao);
                return (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 font-medium">{r.responsible}</td>
                    <td className="py-2 text-center text-gray-600">{Number(r.total)}</td>
                    <td className="py-2 text-center text-green-600 font-medium">{Number(r.vendas)}</td>
                    <td className="py-2 text-center text-red-500">{Number(r.perdidos)}</td>
                    <td className="py-2 text-center">
                      <span style={{ color: conv >= 20 ? "#1D9E75" : conv >= 10 ? "#BA7517" : "#A32D2D" }} className="font-medium">
                        {conv}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        {/* Late tasks */}
        <Card title="Tarefas atrasadas por usuário">
          {lateTasks.length === 0
            ? <p className="text-sm text-green-600">✓ Nenhuma tarefa atrasada</p>
            : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b">
                    <th className="pb-2">Responsável</th>
                    <th className="pb-2 text-center">Atrasadas</th>
                    <th className="pb-2 text-center">Média dias</th>
                    <th className="pb-2 text-center">Máx. dias</th>
                  </tr>
                </thead>
                <tbody>
                  {lateTasks.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 font-medium">{r.responsible}</td>
                      <td className="py-2 text-center text-red-500 font-medium">{Number(r.late_tasks)}</td>
                      <td className="py-2 text-center text-orange-500">{Number(r.avg_days_late)}</td>
                      <td className="py-2 text-center text-red-600 font-medium">{Number(r.max_days_late)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Card>
      </div>
    </main>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border p-5 mb-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">{title}</h2>
      {children}
    </div>
  );
}
