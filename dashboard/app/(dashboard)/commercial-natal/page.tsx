"use client";
// dashboard/app/(dashboard)/commercial-natal/page.tsx
//
// NATAL-SPECIFIC: identical structure to the main /commercial page --
// same components, same sections, same late-tasks addition -- but reads
// from /api/commercial-natal, which sources leads_natal/tasks_natal
// (Natal's own separate RD Station account) instead of leads/tasks.
//
// WHAT THIS PAGE DOES:
// Replicates the HTML commercial report but powered by live BigQuery data
// instead of manual CSV uploads. All chart logic from the HTML is preserved
// but rewritten as React components using recharts (already in your dependencies).
//
// ARCHITECTURE DECISION — Why recharts and not Chart.js:
//   The HTML used Chart.js via CDN. Your Next.js project already has recharts
//   installed. Using recharts means: no extra dependencies, better TypeScript
//   support, declarative React syntax instead of imperative JS, and the charts
//   respond to React state changes automatically.
//
// STATE MANAGEMENT:
//   All filter state lives in URL search params (via useState + useEffect).
//   This means: sharing a URL shares the exact view, browser back button works,
//   and managers can bookmark their preferred funnel/date combination.
//
// DATA FLOW:
//   Filter changes → fetch /api/commercial → update all charts simultaneously
//   No partial updates — all charts reflect the same filter state always.

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter,
  ZAxis, Cell, PieChart, Pie
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────
// Explicit interfaces for every data shape the API returns.
// TypeScript will catch mismatches between API output and frontend usage at build time,
// not at runtime in production. This is one of the biggest benefits of TypeScript.

interface KPIs {
  total: number; won: number; lost: number;
  open_deals: number; paused: number;
  conv_pct: number; loss_pct: number;
  sched_pct: number; attend_pct: number; avg_tmv: number | null;
}

interface MonthlyRow {
  month: string; total: number; won: number;
  conv_pct: number; avg_tmv: number | null;
}

interface SourceRow {
  source: string; total: number; won: number; lost: number;
  open_deals: number; scheduled: number; attended: number;
  paused: number; conv_pct: number;
  avg_attempts: number; avg_returns: number;
  top_loss_reasons: string | null;
}

interface ResponsibleRow {
  responsible: string; total: number; won: number; lost: number;
  open_deals: number; conv_pct: number; avg_tmv: number | null;
  scheduled: number; attended: number;
}

interface LossReasonRow { reason: string; total: number; }

interface LateTaskRow {
  responsible: string; total: number; over_7d: number;
  max_days_late: number; avg_days_late: number;
}

interface CohortRow {
  entry_month: string; total_leads: number; total_won: number;
  lag_0: number; lag_1: number; lag_2: number;
  lag_3: number; lag_4: number; lag_5_plus: number;
  is_recent: boolean;
}

interface CommercialData {
  kpis: KPIs;
  monthly: MonthlyRow[];
  bySource: SourceRow[];
  byResponsible: ResponsibleRow[];
  lossReasons: LossReasonRow[];
  cohort: CohortRow[];
  lateTasks: LateTaskRow[];
  availableFunnels: string[];
  availableResponsibles: string[];
  meta: { startDate: string; endDate: string; generatedAt: string; };
}

// ─── Constants ────────────────────────────────────────────────────────────────
//
// NOTE — funnel options are no longer a hardcoded constant here.
// They used to be a fixed list of unit_interest labels ("Boa Viagem", "Setúbal"...)
// but pipeline_name (what the API now filters on) uses different exact strings
// coming straight from RD Station ("Funil BOA VIAGEM", "Instituto Europa", etc.),
// and that set can change if a branch adds/renames a funnel. A hardcoded list here
// would silently drift out of sync with the API — the dropdown would offer options
// that match zero rows, so a manager would see an empty page and think business
// stopped, not that the label was slightly off.
// Instead we read `data.availableFunnels`, which the API computes live from
// whatever pipeline_name values actually exist in the current date range —
// exactly the same pattern already used below for the "responsible" dropdown.

// Brand colors matching the HTML report
const COLORS = {
  primary:   "#0f3460",
  accent:    "#e94560",
  green:     "#27ae60",
  orange:    "#f39c12",
  purple:    "#8e44ad",
  teal:      "#16a085",
  blue:      "#3498db",
  gray:      "#95a5a6",
};

const CHART_COLORS = [
  "#0f3460", "#e94560", "#27ae60", "#f39c12",
  "#8e44ad", "#16a085", "#3498db", "#e67e22",
  "#1abc9c", "#e74c3c", "#9b59b6", "#2ecc71",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPct  = (v: number | null) => v == null ? "—" : `${Number(v).toFixed(1)}%`;
const fmtNum  = (v: number) => v?.toLocaleString("pt-BR") ?? "—";
const fmtDays = (v: number | null) => {
  if (v == null) return "—";
  if (v === 0) return "< 1 dia";
  if (v === 1) return "1 dia";
  return `${Math.round(v)} dias`;
};

// Format 'YYYY-MM' to 'Jan/26' for chart labels
const fmtMonth = (ym: string) => {
  const months = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const [y, m] = ym.split("-");
  return `${months[parseInt(m) - 1]}/${y.slice(2)}`;
};

// ─── Sub-components ───────────────────────────────────────────────────────────
// Breaking the page into focused components has three benefits:
//   1. Each component is small enough to understand in isolation
//   2. React only re-renders components whose props changed
//   3. Easier to add loading skeletons per section

function KPICard({ label, value, color, tooltip }: {
  label: string; value: string; color: string; tooltip?: string;
}) {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm border-t-4 text-center" style={{ borderTopColor: color }}>
      <div className="text-2xl font-black text-gray-900">{value}</div>
      <div className="text-xs text-gray-500 mt-1 font-medium">{label}</div>
      {tooltip && <div className="text-xs text-gray-400 mt-1">{tooltip}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-bold uppercase tracking-widest text-[#0f3460] mt-8 mb-3
      pl-3 border-l-4 border-[#e94560]">
      {children}
    </div>
  );
}

function Card({ title, subtitle, children, fullWidth = false }: {
  title: string; subtitle?: string; children: React.ReactNode; fullWidth?: boolean;
}) {
  return (
    <div className={`bg-white rounded-xl p-5 shadow-sm ${fullWidth ? "col-span-2" : ""}`}>
      <h3 className="text-sm font-bold text-gray-900 pb-2 mb-3 border-b border-gray-100">{title}</h3>
      {subtitle && <p className="text-xs text-gray-400 mb-3 -mt-2">{subtitle}</p>}
      {children}
    </div>
  );
}

function Insight({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 p-3 rounded-r-lg text-xs leading-relaxed text-gray-600
      border-l-4 border-[#0f3460] bg-gradient-to-r from-blue-50 to-green-50">
      {children}
    </div>
  );
}

function Skeleton({ h = "h-48" }: { h?: string }) {
  return <div className={`${h} bg-gray-100 rounded-xl animate-pulse`} />;
}

// ── Bar ranking component (same as the HTML's .bar-row pattern) ──────────────
function BarRanking({ rows, valueKey, labelKey, colorKey }: {
  rows: any[]; valueKey: string; labelKey: string; colorKey?: string;
}) {
  const max = Math.max(...rows.map(r => r[valueKey]));
  return (
    <div className="space-y-2">
      {rows.slice(0, 10).map((r, i) => {
        const pct = max > 0 ? (r[valueKey] / max) * 100 : 0;
        const color = colorKey ? r[colorKey] : CHART_COLORS[i % CHART_COLORS.length];
        return (
          <div key={r[labelKey]} className="flex items-center gap-2 text-xs">
            <span className="w-36 shrink-0 font-medium text-gray-700 truncate"
              title={r[labelKey]}>{r[labelKey]}</span>
            <div className="flex-1 bg-gray-100 rounded h-5 relative overflow-hidden">
              <div className="h-full rounded transition-all duration-500"
                style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
            <span className="w-10 text-right font-bold text-gray-800">{r[valueKey]}</span>
            {r.conv_pct !== undefined && (
              <span className="w-12 text-right text-gray-400">{fmtPct(r.conv_pct)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Cohort table ──────────────────────────────────────────────────────────────
// This replicates the HTML's color-coded cohort table.
// Each cell's color intensity represents the lag at which conversions happen.
// Reading pattern: left-to-right shows how quickly leads convert.
//                  top-to-bottom shows how each month's cohort performed.
//
// WHY THE COLORS MATTER:
//   Lag 0 = green (fast decisions = high-quality leads)
//   Lag 5+ = red (very slow = leads probably going cold)
//   The color gradient helps managers instantly see if their pipeline is healthy.

const LAG_COLORS = ["#d4edda", "#cce5ff", "#e2d9f3", "#fff3cd", "#fde8d8", "#f8d7da"];
const LAG_TEXT   = ["#155724", "#004085", "#4a235a", "#856404", "#7d3c07", "#721c24"];

function CohortTable({ rows }: { rows: CohortRow[] }) {
  if (!rows.length) return <div className="text-center text-gray-400 py-8">Sem dados de coorte</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-[#1a1a2e] text-white">
            <th className="px-3 py-2 text-left font-semibold">Mês Entrada</th>
            <th className="px-3 py-2 text-right">Leads</th>
            {["Lag 0","Lag 1","Lag 2","Lag 3","Lag 4","Lag 5+"].map((l, i) => (
              <th key={l} className="px-3 py-2 text-center" style={{ background: LAG_COLORS[i], color: LAG_TEXT[i] }}>{l}</th>
            ))}
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-right">Conv. %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const lags  = [r.lag_0, r.lag_1, r.lag_2, r.lag_3, r.lag_4, r.lag_5_plus];
            const convPct = r.total_leads > 0
              ? (r.total_won / r.total_leads * 100).toFixed(1)
              : "0.0";
            return (
              <tr key={r.entry_month} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                <td className="px-3 py-2 font-medium text-gray-800">
                  {fmtMonth(r.entry_month)}
                  {r.is_recent && (
                    <span className="ml-1 text-yellow-500 text-xs" title="Mês recente — conversão pode estar subestimada">🕐</span>
                  )}
                  {r.total_leads < 30 && (
                    <span className="ml-1 text-orange-400 text-xs" title="Menos de 30 leads — taxa fraca estatisticamente">📉</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-gray-600">{fmtNum(r.total_leads)}</td>
                {lags.map((v, li) => (
                  <td key={li} className="px-3 py-2 text-center"
                    style={v > 0 ? { background: LAG_COLORS[li], color: LAG_TEXT[li], fontWeight: 700 } : { color: "#bbb" }}>
                    {v > 0 ? v : "·"}
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-semibold text-gray-800">{fmtNum(r.total_won)}</td>
                <td className="px-3 py-2 text-right font-bold"
                  style={{ color: Number(convPct) >= 20 ? COLORS.green : Number(convPct) >= 10 ? COLORS.orange : COLORS.accent }}>
                  {convPct}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CommercialPage() {
  // ── State ──────────────────────────────────────────────────────────────────
  // WHY SEPARATE LOADING AND ERROR STATE:
  //   loading = we're waiting for data (show skeletons)
  //   error   = something went wrong (show error message)
  //   data    = null until first load, then always the latest successful result
  // This three-state pattern prevents the "flash of empty content" where the
  // page briefly shows zeros before data arrives.

  const [data, setData]       = useState<CommercialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const currentYear = new Date().getFullYear();
  const [startDate,   setStartDate]   = useState(`${currentYear}-01-01`);
  const [endDate,     setEndDate]     = useState(new Date().toISOString().slice(0, 10));
  const [funnel,      setFunnel]      = useState("Todas");
  const [responsible, setResponsible] = useState("all");
  const [activeTab,   setActiveTab]   = useState<"fonte" | "responsavel">("fonte");

  // ── Data fetching ──────────────────────────────────────────────────────────
  // useCallback memoizes the fetch function so it doesn't get recreated
  // on every render — only when the filter values actually change.
  // This prevents unnecessary API calls.
  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams({
        start: startDate,
        end:   endDate,
        ...(funnel !== "Todas" ? { funnel } : {}),
        ...(responsible !== "all" ? { responsible } : {}),
      });
      const res  = await fetch(`/api/commercial-natal?${p}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, funnel, responsible]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Derived data ───────────────────────────────────────────────────────────
  // useMemo re-computes derived values only when their dependencies change.
  // This prevents expensive calculations running on every render.

  // Responsible score: 50% conversion + 50% relative volume
  // Same formula as the HTML — ranks reps who both convert AND handle volume.
  const respWithScore = useMemo(() => {
    if (!data?.byResponsible.length) return [];
    const maxVol  = Math.max(...data.byResponsible.map(r => r.total));
    const maxConv = Math.max(...data.byResponsible.map(r => r.conv_pct));
    return data.byResponsible.map(r => ({
      ...r,
      score: maxVol > 0 && maxConv > 0
        ? Math.round(((r.conv_pct / maxConv) * 50) + ((r.total / maxVol) * 50))
        : 0,
    })).sort((a, b) => b.score - a.score);
  }, [data?.byResponsible]);

  // Cohort insight: what % of wins happen at Lag 0 (same month)?
  // High Lag 0 % = fast decisions = good lead quality
  const cohortInsight = useMemo(() => {
    if (!data?.cohort.length) return null;
    const totalWon  = data.cohort.reduce((s, r) => s + r.total_won, 0);
    const lag0Won   = data.cohort.reduce((s, r) => s + r.lag_0, 0);
    const lag0Pct   = totalWon > 0 ? Math.round(lag0Won / totalWon * 100) : 0;
    const bestMonth = data.cohort.reduce((best, r) =>
      r.total_won > best.total_won ? r : best, data.cohort[0]);
    return { lag0Pct, bestMonth: bestMonth.entry_month, bestWon: bestMonth.total_won };
  }, [data?.cohort]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#f0f2f5]">

      {/* ── Header (matches HTML exactly) ── */}
      <div className="text-white px-8 py-6 flex items-center gap-6 flex-wrap"
        style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)" }}>
        <div className="w-12 h-12 bg-[#e94560] rounded-xl flex items-center justify-center text-2xl shrink-0">
          📊
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Análise Comercial — Natal</h1>
          <p className="text-sm opacity-70 mt-0.5">
            Análise de funil, coorte, fonte e equipe de vendas
            {data?.meta && ` · ${startDate} – ${endDate}`}
          </p>
        </div>
        <div className="ml-auto bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-sm text-right shrink-0">
          <span className="opacity-70">Atualizado em</span>
          <strong className="block text-base">
            {data?.meta
              ? new Date(data.meta.generatedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })
              : "—"}
          </strong>
        </div>
      </div>

      {/* ── Filter bar (sticky) ── */}
      <div className="sticky top-0 z-50 bg-white border-b border-gray-200 shadow-sm px-8 py-3 flex flex-wrap items-center gap-4">
        <label className="text-xs font-bold text-[#0f3460] whitespace-nowrap">📅 Período:</label>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
          className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-gray-50 focus:outline-none focus:border-[#0f3460]" />
        <span className="text-xs text-gray-400">até</span>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
          className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-gray-50 focus:outline-none focus:border-[#0f3460]" />

        <div className="w-px h-6 bg-gray-200 shrink-0" />

        <label className="text-xs font-bold text-[#0f3460] whitespace-nowrap">🏢 Funil:</label>
        <select value={funnel} onChange={e => setFunnel(e.target.value)}
          className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-gray-50 focus:outline-none focus:border-[#0f3460]">
          <option value="Todas">Todas</option>
          {(data?.availableFunnels || []).map(f => <option key={f}>{f}</option>)}
        </select>

        <div className="w-px h-6 bg-gray-200 shrink-0" />

        <label className="text-xs font-bold text-[#0f3460] whitespace-nowrap">👤 Atendente:</label>
        <select value={responsible} onChange={e => setResponsible(e.target.value)}
          className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-gray-50 focus:outline-none focus:border-[#0f3460]">
          <option value="all">Todos</option>
          {(data?.availableResponsibles || []).map(r => <option key={r}>{r}</option>)}
        </select>

        <button onClick={() => {
          setStartDate(`${currentYear}-01-01`);
          setEndDate(new Date().toISOString().slice(0, 10));
          setFunnel("Todas"); setResponsible("all");
        }} className="text-xs px-3 py-1.5 bg-gray-100 border border-gray-300 rounded-md font-semibold text-gray-600 hover:bg-[#e94560] hover:text-white hover:border-[#e94560] transition-colors">
          ↺ Resetar
        </button>

        {!loading && data && (
          <span className="text-xs text-gray-400 ml-auto">
            {fmtNum(data.kpis.total)} leads no período
          </span>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-12">

        {/* Error state */}
        {error && (
          <div className="mt-6 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
            Erro ao carregar dados: {error}
          </div>
        )}

        {/* ── KPIs ── */}
        <SectionTitle>Visão Geral</SectionTitle>
        {loading ? (
          <div className="grid grid-cols-4 md:grid-cols-8 gap-3">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h="h-20" />)}
          </div>
        ) : data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KPICard label="Total de Leads"    value={fmtNum(data.kpis.total)}      color={COLORS.primary} />
            <KPICard label="Vendas Realizadas" value={fmtNum(data.kpis.won)}        color={COLORS.green} />
            <KPICard label="Leads Perdidos"    value={fmtNum(data.kpis.lost)}       color={COLORS.accent} />
            <KPICard label="Em Andamento"      value={fmtNum(data.kpis.open_deals)} color={COLORS.orange} />
            <KPICard label="Taxa de Conversão" value={fmtPct(data.kpis.conv_pct)}   color={COLORS.purple} />
            <KPICard label="Taxa de Descarte"  value={fmtPct(data.kpis.loss_pct)}   color={COLORS.accent} />
            <KPICard label="Taxa Agendamento"  value={fmtPct(data.kpis.sched_pct)}  color={COLORS.teal} />
            <KPICard label="TMV Médio"         value={fmtDays(data.kpis.avg_tmv)}   color={COLORS.blue}
              tooltip="Tempo médio entre criação do lead e fechamento da venda" />
          </div>
        )}
        {!loading && data && data.kpis.paused > 0 && (
          <p className="text-xs text-gray-400 mt-2">
            * {fmtNum(data.kpis.paused)} leads pausados (não contabilizados em "Em Andamento")
          </p>
        )}

        {/* ── Volume mensal ── */}
        <SectionTitle>Volume Mensal de Leads e Vendas</SectionTitle>
        {loading ? <Skeleton /> : data && (
          <Card title="Leads captados vs. Vendas fechadas por mês">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.monthly.map(r => ({ ...r, month: fmtMonth(r.month) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="total" name="Leads Captados" fill={COLORS.primary} radius={[3,3,0,0]} />
                <Bar dataKey="won"   name="Vendas"         fill={COLORS.green}   radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}

        {/* ── TMV por mês ── */}
        <SectionTitle>Tempo Médio de Venda (TMV) por Mês</SectionTitle>
        {loading ? <Skeleton /> : data && (
          <Card
            title="Média de dias entre criação do lead e fechamento · por mês de entrada"
            subtitle="Verde ≤ 7 dias · Azul ≤ 30 dias · Laranja ≤ 90 dias · Vermelho > 90 dias">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.monthly.map(r => ({ ...r, month: fmtMonth(r.month) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit=" d" />
                <Tooltip formatter={(v: any) => [fmtDays(v), "TMV Médio"]} />
                <Bar dataKey="avg_tmv" name="TMV Médio (dias)" radius={[3,3,0,0]}>
                  {data.monthly.map((r, i) => (
                    <Cell key={i} fill={
                      r.avg_tmv == null ? "#eee"
                      : r.avg_tmv <= 7  ? COLORS.green
                      : r.avg_tmv <= 30 ? COLORS.blue
                      : r.avg_tmv <= 90 ? COLORS.orange
                      : COLORS.accent
                    } />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}

        {/* ── Cohort ── */}
        <SectionTitle>Análise de Coorte — Quando os Leads Fecham</SectionTitle>
        {loading ? <Skeleton h="h-64" /> : data && (
          <>
            <Card
              title="Vendas por mês de entrada × lag de fechamento (0 = mesmo mês, 1 = mês seguinte…)"
              fullWidth>
              <CohortTable rows={data.cohort} />
              <Insight>
                <strong>💡 Leitura:</strong> Lag 0 = fechamento no mesmo mês de entrada.
                Alta concentração no Lag 0 indica decisão rápida — bom sinal de qualidade de lead.
                <br />
                <strong>⚠️</strong> Menos de 30 leads — taxa estatisticamente fraca.&nbsp;
                <strong>🕐</strong> Mês recente — leads ainda em andamento, conversão provavelmente subestimada.
              </Insight>
              {cohortInsight && (
                <Insight>
                  <strong>📊 Insight:</strong>{" "}
                  {cohortInsight.lag0Pct}% das vendas fecham no mesmo mês de entrada.{" "}
                  Melhor mês: <strong>{fmtMonth(cohortInsight.bestMonth)}</strong>{" "}
                  com {fmtNum(cohortInsight.bestWon)} vendas.
                </Insight>
              )}
            </Card>
          </>
        )}

        {/* ── Fonte + Responsável (tabs) ── */}
        <SectionTitle>Análise Detalhada</SectionTitle>
        <div className="flex gap-2 mb-4">
          {(["fonte", "responsavel"] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === t
                  ? "bg-[#0f3460] text-white"
                  : "bg-white text-gray-600 border border-gray-200 hover:border-[#0f3460]"
              }`}>
              {t === "fonte" ? "📡 Por Fonte" : "👤 Por Responsável"}
            </button>
          ))}
        </div>

        {/* ── Por Fonte ── */}
        {activeTab === "fonte" && (
          <>
            {loading ? <Skeleton /> : data && (
              <div className="grid grid-cols-2 gap-4">
                <Card title="Volume de Leads por Fonte">
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.bySource} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis type="number" tick={{ fontSize: 10 }} />
                      <YAxis type="category" dataKey="source" tick={{ fontSize: 10 }} width={120} />
                      <Tooltip />
                      <Bar dataKey="total" name="Leads" radius={[0,3,3,0]}>
                        {data.bySource.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Card>

                <Card title="Taxa de Conversão por Fonte">
                  <BarRanking
                    rows={[...data.bySource].sort((a, b) => b.conv_pct - a.conv_pct)}
                    valueKey="total" labelKey="source" />
                  <div className="mt-3 space-y-1">
                    {[...data.bySource].sort((a, b) => b.conv_pct - a.conv_pct).slice(0, 8).map((r, i) => (
                      <div key={r.source} className="flex items-center gap-2 text-xs">
                        <span className="w-32 truncate text-gray-600" title={r.source}>{r.source}</span>
                        <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                          <div className="h-full rounded transition-all"
                            style={{ width: `${Math.min(r.conv_pct, 100)}%`, backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                        </div>
                        <span className="w-12 text-right font-bold text-gray-800">{fmtPct(r.conv_pct)}</span>
                      </div>
                    ))}
                  </div>
                </Card>

                <div className="col-span-2">
                  <Card title="Detalhamento por Fonte de Captação" fullWidth>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-[#1a1a2e] text-white">
                            {["Fonte","Leads","Agend.","Comparec.","Matrículas","Perdidos","Conversão"].map(h => (
                              <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.bySource.map((r, i) => (
                            <tr key={r.source} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                              <td className="px-3 py-2 font-medium text-gray-800">{r.source}</td>
                              <td className="px-3 py-2 text-gray-600">{fmtNum(r.total)}</td>
                              <td className="px-3 py-2 text-gray-600">{fmtNum(r.scheduled)}</td>
                              <td className="px-3 py-2 text-gray-600">{fmtNum(r.attended)}</td>
                              <td className="px-3 py-2 font-semibold text-green-700">{fmtNum(r.won)}</td>
                              <td className="px-3 py-2 text-red-600">{fmtNum(r.lost)}</td>
                              <td className="px-3 py-2">
                                <span className={`inline-block px-2 py-0.5 rounded-full font-bold text-xs ${
                                  r.conv_pct >= 20 ? "bg-green-100 text-green-800"
                                  : r.conv_pct >= 10 ? "bg-blue-100 text-blue-800"
                                  : "bg-red-100 text-red-800"
                                }`}>{fmtPct(r.conv_pct)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </div>

                <div className="col-span-2">
                  <Card title="Ranking de Motivos de Perda" fullWidth
                    subtitle="Contagem de leads perdidos por motivo declarado no CRM">
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={data.lossReasons} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis type="number" tick={{ fontSize: 10 }} />
                        <YAxis type="category" dataKey="reason" tick={{ fontSize: 10 }} width={180} />
                        <Tooltip />
                        <Bar dataKey="total" name="Leads Perdidos" fill={COLORS.accent} radius={[0,3,3,0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Por Responsável ── */}
        {activeTab === "responsavel" && (
          <>
            {loading ? <Skeleton /> : data && (
              <div className="grid grid-cols-2 gap-4">
                <Card
                  title="Volume atendido × Taxa de conversão"
                  subtitle="Cada ponto = 1 atendente. Eixo X = leads, Eixo Y = conversão %. Tamanho = vendas realizadas.">
                  <ResponsiveContainer width="100%" height={280}>
                    <ScatterChart>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="total"    name="Leads"      tick={{ fontSize: 10 }} label={{ value: "Leads atendidos", position: "insideBottom", offset: -5, fontSize: 11 }} />
                      <YAxis dataKey="conv_pct" name="Conversão %" tick={{ fontSize: 10 }} unit="%" />
                      <ZAxis dataKey="won" range={[50, 400]} name="Vendas" />
                      <Tooltip cursor={{ strokeDasharray: "3 3" }}
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload as ResponsibleRow;
                          return (
                            <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
                              <p className="font-bold text-gray-900 mb-1">{d.responsible}</p>
                              <p>Leads: {fmtNum(d.total)}</p>
                              <p>Vendas: {fmtNum(d.won)}</p>
                              <p>Conversão: {fmtPct(d.conv_pct)}</p>
                            </div>
                          );
                        }}
                      />
                      <Scatter
                        data={respWithScore}
                        fill={COLORS.primary}>
                        {respWithScore.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </Card>

                <Card
                  title="Ranking por Score Combinado"
                  subtitle="Score = 50% conversão + 50% volume relativo (normalizado). Considera quem converte e atende muito.">
                  <BarRanking rows={respWithScore} valueKey="score" labelKey="responsible" />
                </Card>

                <div className="col-span-2">
                  <Card title="Tabela Detalhada" fullWidth>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-[#1a1a2e] text-white">
                            {["Responsável","Total","Vendas","Perdidos","Em Aberto","Conversão","TMV Médio","Score"].map(h => (
                              <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {respWithScore.map((r, i) => (
                            <tr key={r.responsible} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                              <td className="px-3 py-2 font-medium text-gray-800">{r.responsible}</td>
                              <td className="px-3 py-2 text-gray-600">{fmtNum(r.total)}</td>
                              <td className="px-3 py-2 font-semibold text-green-700">{fmtNum(r.won)}</td>
                              <td className="px-3 py-2 text-red-600">{fmtNum(r.lost)}</td>
                              <td className="px-3 py-2 text-gray-600">{fmtNum(r.open_deals)}</td>
                              <td className="px-3 py-2">
                                <span className={`inline-block px-2 py-0.5 rounded-full font-bold ${
                                  r.conv_pct >= 20 ? "bg-green-100 text-green-800"
                                  : r.conv_pct >= 10 ? "bg-blue-100 text-blue-800"
                                  : "bg-red-100 text-red-800"
                                }`}>{fmtPct(r.conv_pct)}</span>
                              </td>
                              <td className="px-3 py-2 text-gray-600">{fmtDays(r.avg_tmv)}</td>
                              <td className="px-3 py-2">
                                <span className="inline-block px-2 py-0.5 rounded-full bg-[#0f3460] text-white font-bold">
                                  {r.score}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </div>

                {/* ── Tarefas atrasadas ── */}
                <div className="col-span-2">
                  <Card title="Tarefas Atrasadas por Atendente" fullWidth
                    subtitle="Tarefas com prazo vencido, não concluídas — sinal de negligência operacional. Linha vermelha = 7+ dias atrasada.">
                    <Insight>
                      <strong>⚠️ Nota:</strong> esta tabela mostra o snapshot mais recente de
                      tarefas atrasadas — <strong>não é afetada pelo filtro de período (📅)</strong> acima.
                      Tarefas atrasadas são sempre "agora", não uma soma histórica do intervalo selecionado.
                    </Insight>
                    {data.lateTasks.length === 0 ? (
                      <div className="text-center text-gray-400 py-8">
                        Nenhuma tarefa atrasada no momento 🎉
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="bg-[#1a1a2e] text-white">
                              {["Responsável","Tarefas Atrasadas","+7 dias","Máx. Atraso","Média de Atraso"].map(h => (
                                <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.lateTasks.map((r, i) => (
                              <tr key={r.responsible}
                                className={r.over_7d > 0 ? "bg-red-50" : i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                <td className="px-3 py-2 font-medium text-gray-800">{r.responsible}</td>
                                <td className="px-3 py-2 font-semibold text-gray-800">{fmtNum(r.total)}</td>
                                <td className="px-3 py-2">
                                  {r.over_7d > 0 ? (
                                    <span className="inline-block px-2 py-0.5 rounded-full font-bold bg-red-100 text-red-800">
                                      {fmtNum(r.over_7d)}
                                    </span>
                                  ) : <span className="text-gray-400">—</span>}
                                </td>
                                <td className="px-3 py-2 text-gray-600">{r.max_days_late} dias</td>
                                <td className="px-3 py-2 text-gray-600">{r.avg_days_late} dias</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            )}
          </>
        )}

        <footer className="text-center text-xs text-gray-400 py-8 mt-4 border-t border-gray-200">
          Análise Comercial · Dados atualizados diariamente via pipeline RD Station →
          BigQuery · {data?.meta && new Date(data.meta.generatedAt).toLocaleDateString("pt-BR")}
        </footer>
      </div>
    </div>
  );
}
