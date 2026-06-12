"use client";

import { useEffect, useState, useMemo } from "react";

interface AcademicKPIs   { total_students: number; at_risk_grade: number; pct_at_risk_grade: number; at_risk_attendance: number; pct_at_risk_attendance: number; cancellations: number; real_churn: number; pct_churn: number; }
interface FinancialKPIs  { total_overdue: number; defaulting_students: number; pct_defaulting: number; }
interface OperationalKPIs{ total_lessons: number; completed: number; pending: number; pct_complete: number; }
interface CommercialKPIs  { new_leads: number; conversions: number; conversion_rate: number; }
interface PeriodData { academic: AcademicKPIs; financial: FinancialKPIs; operational: OperationalKPIs; commercial: CommercialKPIs; }
interface Top3Row { source?: string; responsible?: string; count?: number; total?: number; conversions?: number; }

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

function Trend({ from, to, inverse = false }: { from: number; to: number; inverse?: boolean }) {
  const chg = pctChange(from, to);
  if (chg === null || chg === 0) return null;
  const good = inverse ? chg < 0 : chg > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-full ${
      good ? "bg-green-50 text-green-600" : "bg-red-50 text-red-500"
    }`}>
      {chg > 0 ? "↑" : "↓"}{Math.abs(chg)}%
    </span>
  );
}

function fmt(n: number)  { return n.toLocaleString("pt-BR"); }
function fmtR(n: number) { return `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }

function TopKPI({ icon, color, label, value, compare, inverse }: {
  icon: string; color: string; label: string; value: string;
  compare?: string; inverse?: boolean;
}) {
  return (
    <div className="flex items-center gap-4 bg-white rounded-2xl px-5 py-4 shadow-sm border border-gray-100 flex-1">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 ${color}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-400 font-medium mb-0.5">{label}</p>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold text-gray-900 truncate">{value}</span>
          {compare !== undefined && (
            <Trend
              from={parseFloat(compare.replace(/[^0-9.-]/g, ""))}
              to={parseFloat(value.replace(/[^0-9.-]/g, ""))}
              inverse={inverse}
            />
          )}
        </div>
        {compare !== undefined && (
          <p className="text-xs text-gray-400 mt-0.5">{compare} anterior</p>
        )}
      </div>
    </div>
  );
}

function Quadrant({ accentColor, icon, title, children }: {
  accentColor: string; icon: string; title: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className={`px-5 py-3 flex items-center gap-2 border-b border-gray-100 ${accentColor}`}>
        <span className="text-base">{icon}</span>
        <h2 className="text-xs font-bold uppercase tracking-widest">{title}</h2>
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
}

function MetricRow({ label, value, sub, compare, compareSub, color = "text-gray-900", inverse = false }: {
  label: string; value: string; sub?: string;
  compare?: string; compareSub?: string;
  color?: string; inverse?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-500">{label}</span>
      <div className="flex items-center gap-2 text-right">
        {compare !== undefined && (
          <Trend
            from={parseFloat(compare.replace(/[^0-9.-]/g, ""))}
            to={parseFloat(value.replace(/[^0-9.-]/g, ""))}
            inverse={inverse}
          />
        )}
        <div>
          <span className={`text-sm font-bold ${color}`}>{value}</span>
          {sub && <span className="text-xs text-gray-400 ml-1">{sub}</span>}
          {compare !== undefined && (
            <p className="text-xs text-gray-300">{compare}{compareSub ? ` ${compareSub}` : ""}</p>
          )}
        </div>
      </div>
    </div>
  );
}

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

  const periodLabel  = months.find(m => m.val === period)?.label        || period;
  const compareLabel = months.find(m => m.val === comparePeriod)?.label || comparePeriod;

  return (
    <main className="p-6 space-y-5 bg-gray-50 min-h-screen">

      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-400">{periodLabel}</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select value={branch} onChange={e => setBranch(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="all">Todas as unidades</option>
            {["Boa Viagem", "Young", "Setubal", "Natal"].map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>

          <select value={period} onChange={e => setPeriod(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-2 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {months.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
          </select>

          <div className="flex gap-1 bg-gray-200 rounded-xl p-1">
            {(["simple", "compare"] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                  mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
                }`}>
                {m === "simple" ? "Simples" : "Comparar"}
              </button>
            ))}
          </div>

          {mode === "compare" && (
            <select value={comparePeriod} onChange={e => setComparePeriod(e.target.value)}
              className="text-sm border border-blue-200 rounded-xl px-3 py-2 bg-blue-50 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {months.map(m => <option key={m.val} value={m.val}>{m.label}</option>)}
            </select>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-32 text-gray-300 text-sm">Carregando...</div>
      ) : data && (
        <>
          {/* Top KPI strip */}
          <div className="flex gap-3 flex-wrap">
            <TopKPI icon="👥" color="bg-blue-50"   label="Alunos ativos"       value={fmt(data.academic.total_students)}     compare={compareData ? fmt(compareData.academic.total_students)     : undefined} />
            <TopKPI icon="💸" color="bg-red-50"    label="Total em atraso"     value={fmtR(data.financial.total_overdue)}    compare={compareData ? fmtR(compareData.financial.total_overdue)    : undefined} inverse />
            <TopKPI icon="📋" color="bg-green-50"  label="Diário OK"           value={`${data.operational.pct_complete}%`}   compare={compareData ? `${compareData.operational.pct_complete}%`   : undefined} />
            <TopKPI icon="📈" color="bg-purple-50" label="Conversão comercial"  value={`${data.commercial.conversion_rate}%`} compare={compareData ? `${compareData.commercial.conversion_rate}%` : undefined} />
          </div>

          {/* 2×2 quadrant grid */}
          <div className="grid grid-cols-2 gap-4">

            {/* ── ACADEMIC ── */}
            <Quadrant accentColor="bg-blue-50 text-blue-700" icon="📚" title="Acadêmico">
              <MetricRow label="Total de alunos ativos"  value={fmt(data.academic.total_students)}      compare={compareData ? fmt(compareData.academic.total_students) : undefined} />
              <MetricRow label="Em risco (nota < 7)"     value={fmt(data.academic.at_risk_grade)}       sub={`${data.academic.pct_at_risk_grade}%`}       compare={compareData ? fmt(compareData.academic.at_risk_grade) : undefined}      compareSub={compareData ? `${compareData.academic.pct_at_risk_grade}%` : undefined}      color={data.academic.pct_at_risk_grade > 10 ? "text-red-600" : "text-gray-900"} inverse />
              <MetricRow label="Frequência abaixo 70%"   value={fmt(data.academic.at_risk_attendance)}  sub={`${data.academic.pct_at_risk_attendance}%`}  compare={compareData ? fmt(compareData.academic.at_risk_attendance) : undefined} compareSub={compareData ? `${compareData.academic.pct_at_risk_attendance}%` : undefined} color={data.academic.pct_at_risk_attendance > 10 ? "text-red-600" : "text-gray-900"} inverse />
              <MetricRow label="Rescisões no mês"        value={fmt(data.academic.real_churn)}          sub={data.academic.pct_churn > 0 ? `${data.academic.pct_churn}%` : undefined} compare={compareData ? fmt(compareData.academic.real_churn) : undefined} color={data.academic.real_churn > 5 ? "text-red-600" : "text-gray-900"} inverse />
            </Quadrant>

            {/* ── FINANCIAL ── */}
            <Quadrant accentColor="bg-red-50 text-red-700" icon="💸" title="Financeiro">
              <MetricRow label="Total em atraso"         value={fmtR(data.financial.total_overdue)}     compare={compareData ? fmtR(compareData.financial.total_overdue) : undefined}     color="text-red-600" inverse />
              <MetricRow label="Alunos inadimplentes"    value={fmt(data.financial.defaulting_students)} compare={compareData ? fmt(compareData.financial.defaulting_students) : undefined}  color={data.financial.pct_defaulting > 10 ? "text-red-600" : "text-gray-900"} inverse />
              <MetricRow label="% inadimplentes"         value={`${data.financial.pct_defaulting}%`}    compare={compareData ? `${compareData.financial.pct_defaulting}%` : undefined}     color={data.financial.pct_defaulting > 10 ? "text-red-600" : "text-gray-900"} inverse />
            </Quadrant>

            {/* ── OPERATIONAL ── */}
            <Quadrant accentColor="bg-green-50 text-green-700" icon="📋" title="Operacional">
              <MetricRow label="% Diário OK"             value={`${data.operational.pct_complete}%`}  compare={compareData ? `${compareData.operational.pct_complete}%` : undefined}  color={data.operational.pct_complete >= 90 ? "text-green-600" : "text-orange-500"} />
              <MetricRow label="Diários pendentes"       value={fmt(data.operational.pending)}        compare={compareData ? fmt(compareData.operational.pending) : undefined}         color={data.operational.pending > 0 ? "text-orange-500" : "text-green-600"} inverse />
              <MetricRow label="Total de aulas"          value={fmt(data.operational.total_lessons)}  compare={compareData ? fmt(compareData.operational.total_lessons) : undefined} />
            </Quadrant>

            {/* ── COMMERCIAL ── */}
            <Quadrant accentColor="bg-purple-50 text-purple-700" icon="📈" title="Comercial">
              <MetricRow label="Novos leads"             value={fmt(data.commercial.new_leads)}        compare={compareData ? fmt(compareData.commercial.new_leads) : undefined} />
              <MetricRow label="Conversões"              value={fmt(data.commercial.conversions)}      compare={compareData ? fmt(compareData.commercial.conversions) : undefined}   color="text-green-600" />
              <MetricRow label="Taxa de conversão"       value={`${data.commercial.conversion_rate}%`} compare={compareData ? `${compareData.commercial.conversion_rate}%` : undefined} color={data.commercial.conversion_rate >= 20 ? "text-green-600" : "text-orange-500"} />

              <div className="pt-2 border-t border-gray-50 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-gray-400 font-medium mb-2">Top fontes · 30d</p>
                  {top3Sources.length === 0 ? <p className="text-xs text-gray-300">—</p> : top3Sources.map((s, i) => (
                    <div key={i} className="flex justify-between items-center py-0.5">
                      <span className="text-xs text-gray-500 truncate">{i+1}. {s.source || "—"}</span>
                      <span className="text-xs font-semibold text-gray-700 ml-1">{s.count}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium mb-2">Top atendentes · 30d</p>
                  {top3Sales.length === 0 ? <p className="text-xs text-gray-300">—</p> : top3Sales.map((s, i) => (
                    <div key={i} className="flex justify-between items-center py-0.5">
                      <span className="text-xs text-gray-500 truncate">{i+1}. {(s.responsible || "—").split(" ")[0]}</span>
                      <span className="text-xs font-semibold text-green-600 ml-1">{s.conversions}✓</span>
                    </div>
                  ))}
                </div>
              </div>
            </Quadrant>

          </div>
        </>
      )}
    </main>
  );
}
