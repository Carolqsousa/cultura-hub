"use client";

import { useEffect, useState, useMemo } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AcademicKPIs  { total_students: number; at_risk_grade: number; pct_at_risk_grade: number; at_risk_attendance: number; pct_at_risk_attendance: number; }
interface FinancialKPIs { total_overdue: number; defaulting_students: number; pct_defaulting: number; }
interface OperationalKPIs { total_lessons: number; completed: number; pending: number; pct_complete: number; }
interface CommercialKPIs  { new_leads: number; conversions: number; conversion_rate: number; }
interface PeriodData { academic: AcademicKPIs; financial: FinancialKPIs; operational: OperationalKPIs; commercial: CommercialKPIs; }
interface Top3Row { source?: string; responsible?: string; count?: number; total?: number; conversions?: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function monthOptions() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    opts.push({ val, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return opts;
}

function pctChange(a: number, b: number) {
  if (a === 0) return null;
  return Math.round((b - a) / a * 100);
}

function ChangeTag({ from, to, inverse = false }: { from: number; to: number; inverse?: boolean }) {
  const chg = pctChange(from, to);
  if (chg === null) return null;
  const positive = inverse ? chg < 0 : chg > 0;
  const cls = chg === 0 ? "text-gray-400" : positive ? "text-green-600" : "text-red-500";
  const arrow = chg > 0 ? "↑" : chg < 0 ? "↓" : "–";
  return <span className={`text-xs font-medium ml-1 ${cls}`}>{arrow}{Math.abs(chg)}%</span>;
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KPICard({
  label, value, subValue, compareValue, compareSubValue, color = "text-gray-900", inverse = false
}: {
  label: string; value: string; subValue?: string;
  compareValue?: string; compareSubValue?: string;
  color?: string; inverse?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">{label}</p>
      <div className="flex items-end gap-2">
        <p className={`text-2xl font-bold ${color}`}>{value}</p>
        {subValue && <p className="text-sm text-gray-400 mb-0.5">{subValue}</p>}
      </div>
      {compareValue !== undefined && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <div className="flex items-end gap-1">
            <p className="text-lg font-semibold text-gray-500">{compareValue}</p>
            {compareSubValue && <p className="text-xs text-gray-400 mb-0.5">{compareSubValue}</p>}
            <ChangeTag
              from={parseFloat(compareValue.replace(/[^0-9.-]/g, ""))}
              to={parseFloat(value.replace(/[^0-9.-]/g, ""))}
              inverse={inverse}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-lg">{icon}</span>
      <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">{title}</h2>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function OverviewPage() {
  const months = useMemo(() => monthOptions(), []);

  const [branch, setBranch]               = useState("all");
  const [mode, setMode]                   = useState<"simple" | "compare">("simple");
  const [period, setPeriod]               = useState(months[0].val);
  const [comparePeriod, setComparePeriod] = useState(months[1].val);
  const [data, setData]                   = useState<PeriodData | null>(null);
  const [compareData, setCompareData]     = useState<PeriodData | null>(null);
  const [top3Sources, setTop3Sources]     = useState<Top3Row[]>([]);
  const [top3Sales, setTop3Sales]         = useState<Top3Row[]>([]);
  const [loading, setLoading]             = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ branch, period });
    if (mode === "compare") params.set("compare_period", comparePeriod);
    fetch(`/api/overview?${params}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setData(d.data);
        setCompareData(d.compare || null);
        setTop3Sources(d.top3_sources || []);
        setTop3Sales(d.top3_sales   || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [branch, period, comparePeriod, mode]);

  const periodLabel  = months.find(m => m.val === period)?.label         || period;
  const compareLabel = months.find(m => m.val === comparePeriod)?.label  || comparePeriod;

  const fmt = (n: number) => n.toLocaleString("pt-BR");
  const fmtR = (n: number) => `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;

  return (
    <main className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Visão geral — todas as unidades</p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Branch */}
        <select value={branch} onChange={e => setBranch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">Todas as unidades</option>
          {["Boa Viagem", "Young", "Setubal", "Natal"].map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        {/* Period */}
        <select value={period} onChange={e => setPeriod(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          {months.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
        </select>

        {/* Mode toggle */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(["simple", "compare"] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {m === "simple" ? "Simples" : "Comparar"}
            </button>
          ))}
        </div>

        {/* Compare period picker */}
        {mode === "compare" && (
          <select value={comparePeriod} onChange={e => setComparePeriod(e.target.value)}
            className="text-sm border border-blue-300 rounded-lg px-3 py-2 bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
            {months.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>
        )}
      </div>

      {/* Period labels in compare mode */}
      {mode === "compare" && (
        <div className="flex gap-4 text-xs text-gray-500">
          <span className="font-semibold text-gray-800">{periodLabel}</span>
          <span>vs</span>
          <span className="text-blue-600 font-semibold">{compareLabel}</span>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-20">Carregando...</div>
      ) : data && (
        <div className="space-y-6">

          {/* ── ACADEMIC ── */}
          <div>
            <SectionTitle icon="📚" title="Acadêmico" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard
                label="Total de alunos ativos"
                value={fmt(data.academic.total_students)}
                compareValue={compareData ? fmt(compareData.academic.total_students) : undefined}
              />
              <KPICard
                label="Em risco acadêmico (nota < 7)"
                value={fmt(data.academic.at_risk_grade)}
                subValue={`${data.academic.pct_at_risk_grade}%`}
                compareValue={compareData ? fmt(compareData.academic.at_risk_grade) : undefined}
                compareSubValue={compareData ? `${compareData.academic.pct_at_risk_grade}%` : undefined}
                color={data.academic.pct_at_risk_grade > 10 ? "text-red-600" : "text-gray-900"}
                inverse
              />
              <KPICard
                label="Frequência abaixo de 70%"
                value={fmt(data.academic.at_risk_attendance)}
                subValue={`${data.academic.pct_at_risk_attendance}%`}
                compareValue={compareData ? fmt(compareData.academic.at_risk_attendance) : undefined}
                compareSubValue={compareData ? `${compareData.academic.pct_at_risk_attendance}%` : undefined}
                color={data.academic.pct_at_risk_attendance > 10 ? "text-red-600" : "text-gray-900"}
                inverse
              />
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Cancelamentos</p>
                <p className="text-2xl font-bold text-gray-300">Em breve</p>
              </div>
            </div>
          </div>

          {/* ── FINANCIAL ── */}
          <div>
            <SectionTitle icon="💸" title="Financeiro" />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <KPICard
                label="Total em atraso"
                value={fmtR(data.financial.total_overdue)}
                compareValue={compareData ? fmtR(compareData.financial.total_overdue) : undefined}
                color="text-red-600"
                inverse
              />
              <KPICard
                label="Alunos inadimplentes"
                value={fmt(data.financial.defaulting_students)}
                compareValue={compareData ? fmt(compareData.financial.defaulting_students) : undefined}
                color={data.financial.pct_defaulting > 10 ? "text-red-600" : "text-gray-900"}
                inverse
              />
              <KPICard
                label="% alunos inadimplentes"
                value={`${data.financial.pct_defaulting}%`}
                compareValue={compareData ? `${compareData.financial.pct_defaulting}%` : undefined}
                color={data.financial.pct_defaulting > 10 ? "text-red-600" : "text-gray-900"}
                inverse
              />
            </div>
          </div>

          {/* ── OPERATIONAL ── */}
          <div>
            <SectionTitle icon="📋" title="Operacional" />
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <KPICard
                label="% Diário OK"
                value={`${data.operational.pct_complete}%`}
                compareValue={compareData ? `${compareData.operational.pct_complete}%` : undefined}
                color={data.operational.pct_complete >= 90 ? "text-green-600" : "text-orange-500"}
              />
              <KPICard
                label="Diários pendentes"
                value={fmt(data.operational.pending)}
                compareValue={compareData ? fmt(compareData.operational.pending) : undefined}
                color={data.operational.pending > 0 ? "text-orange-500" : "text-green-600"}
                inverse
              />
            </div>
          </div>

          {/* ── COMMERCIAL ── */}
          <div>
            <SectionTitle icon="📈" title="Comercial" />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              <KPICard
                label="Novos leads"
                value={fmt(data.commercial.new_leads)}
                compareValue={compareData ? fmt(compareData.commercial.new_leads) : undefined}
              />
              <KPICard
                label="Conversões"
                value={fmt(data.commercial.conversions)}
                compareValue={compareData ? fmt(compareData.commercial.conversions) : undefined}
                color="text-green-600"
              />
              <KPICard
                label="Taxa de conversão"
                value={`${data.commercial.conversion_rate}%`}
                compareValue={compareData ? `${compareData.commercial.conversion_rate}%` : undefined}
                color={data.commercial.conversion_rate >= 20 ? "text-green-600" : "text-orange-500"}
              />
            </div>

            {/* Top 3 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-3">Top 3 Fontes — últimos 30 dias</p>
                {top3Sources.length === 0 ? (
                  <p className="text-sm text-gray-400">Sem dados</p>
                ) : top3Sources.map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
                      <span className="text-sm text-gray-700">{s.source || "—"}</span>
                    </div>
                    <span className="text-sm font-semibold text-gray-900">{s.count}</span>
                  </div>
                ))}
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-3">Top 3 Atendentes — últimos 30 dias</p>
                {top3Sales.length === 0 ? (
                  <p className="text-sm text-gray-400">Sem dados</p>
                ) : top3Sales.map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
                      <span className="text-sm text-gray-700">{s.responsible || "—"}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-semibold text-green-600">{s.conversions} conv.</span>
                      <span className="text-xs text-gray-400 ml-1">/ {s.total}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      )}
    </main>
  );
}
