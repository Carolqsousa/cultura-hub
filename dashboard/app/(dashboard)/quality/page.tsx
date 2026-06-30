"use client";
// dashboard/app/(dashboard)/quality/page.tsx

import { useState, useEffect, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StageRow {
  stage: string;
  quant_anterior: number;
  quant_atual: number;
  real_churn: number;
  retention_pct: number | null;
}
interface ClassRow {
  class_name: string; stage: string; branch: string; teacher: string;
  student_count: number; avg_freq: number | null;
  total_cancels: number; real_churn: number; retention_pct: number | null;
}
interface TeacherRow {
  teacher: string; class_count: number; student_count: number;
  avg_freq: number | null; total_cancels: number; real_churn: number; retention_pct: number | null;
}
interface CancelRow {
  event_date: string; branch: string; student_name: string; class_name: string;
  stage: string; teacher: string; reason: string; attendant: string;
  is_real_churn: boolean; is_turma_nao_formou: boolean;
}
interface ReasonRow { reason: string; count: number; real_churn: number; }
interface QualityData {
  snapDates: { start: string; end: string };
  byStage: StageRow[]; byClass: ClassRow[]; byTeacher: TeacherRow[];
  cancels: CancelRow[]; reasons: ReasonRow[];
}
interface RenewalRow {
  student_id: string; name: string; branch: string;
  status: "Renovado" | "Pendente" | "Cancelado";
  next_class_id: string; latest_check_date: string; baseline_date: string;
}
interface RenewalSummary { status: string; students: number; }
interface RenewalBranch {
  branch: string; renovado: number; pendente: number;
  cancelado: number; total: number; renewal_pct: number | null;
}
interface RenewalMeta { last_checked: string; baseline_date: string; next_semester: string; }
interface RenewalData {
  summary: RenewalSummary[]; byBranch: RenewalBranch[];
  detail: RenewalRow[]; meta: RenewalMeta | null;
}

const BRANCHES = ["Todas", "Boa Viagem", "Young", "Setubal", "Natal"];
type Tab = "stage" | "teacher" | "class" | "cancels" | "renewal";
type SortDir = "asc" | "desc";

const STAGE_LABELS: Record<string, string> = {
  ADV:"Advanced", BGN:"Beginner", ELE:"Elementary", INT:"Intermediate",
  MST:"Master", PRI:"Pre-Intermediate", PTEE:"Pre-Teen", TEA:"Tea Time",
  TEE:"Teen", TOD:"Toddler", UPP:"Upper Intermediate", VAN:"Vantage",
  JUN:"Junior", STA:"Stars", PSTA:"Pre-Stars", NUR:"Nursery",
  YNG:"Young", TTM:"Tea Time", FRA:"Francês", CPSTA:"Cultura Plus",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPct   = (v: number | null) => v == null ? "—" : `${Number(v).toFixed(0)}%`;
const fmtNum   = (v: number) => v.toLocaleString("pt-BR");
const calcRet  = (s: number, c: number): number | null => s ? Math.round((s - c) / s * 1000) / 10 : null;
const retColor = (v: number | null) =>
  v == null ? "text-gray-400" : v >= 90 ? "text-emerald-600" : v >= 75 ? "text-amber-500" : "text-red-500";
const freqColor = (v: number | null) =>
  v == null ? "text-gray-400" : v >= 85 ? "text-emerald-600" : v >= 70 ? "text-amber-500" : "text-red-500";

const STATUS_COLOR: Record<string, string> = {
  Renovado:  "bg-emerald-50 text-emerald-700",
  Pendente:  "bg-amber-50 text-amber-700",
  Cancelado: "bg-red-50 text-red-600",
};
const STATUS_DOT: Record<string, string> = {
  Renovado: "🟢", Pendente: "🟡", Cancelado: "🔴",
};

function RetBar({ pct }: { pct: number | null }) {
  const v = pct ?? 0;
  const color = v >= 90 ? "#10b981" : v >= 75 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(v, 100)}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-bold tabular-nums w-9 text-right" style={{ color }}>
        {pct == null ? "—" : `${v}%`}
      </span>
    </div>
  );
}

function Skeleton({ rows = 4, cols = 5 }) {
  return <>{Array.from({ length: rows }).map((_, i) => (
    <tr key={i}>{Array.from({ length: cols }).map((_, j) => (
      <td key={j} className="px-3 py-3"><div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" /></td>
    ))}</tr>
  ))}</>;
}

type SortState = { key: string; dir: SortDir };
function useSort(init: SortState) {
  const [s, set] = useState(init);
  const toggle = (k: string) => set(p => ({ key: k, dir: p.key === k && p.dir === "asc" ? "desc" : "asc" }));
  return [s, toggle] as const;
}
function sortRows<T>(rows: T[], s: SortState): T[] {
  return [...rows].sort((a, b) => {
    const av = (a as any)[s.key] ?? ""; const bv = (b as any)[s.key] ?? "";
    return s.dir === "asc"
      ? String(av).localeCompare(String(bv), "pt-BR", { numeric: true })
      : String(bv).localeCompare(String(av), "pt-BR", { numeric: true });
  });
}
function Th({ label, col, sort, onSort, align = "left" }: {
  label: string; col: string; sort: SortState; onSort: (k: string) => void; align?: "left" | "right";
}) {
  const active = sort.key === col;
  return (
    <th onClick={() => onSort(col)}
      className={`px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800 ${align === "right" ? "text-right" : "text-left"}`}>
      {label} {active ? (sort.dir === "asc" ? "↑" : "↓") : <span className="text-gray-300">↕</span>}
    </th>
  );
}
function EmptyState({ msg = "Nenhum dado para os filtros selecionados." }) {
  return <div className="text-center py-16 text-gray-400"><p className="text-3xl mb-2">📭</p><p className="text-sm">{msg}</p></div>;
}

function StageCard({ row }: { row: StageRow }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold tracking-widest uppercase text-gray-400">{STAGE_LABELS[row.stage] || row.stage}</span>
        <span className={`text-sm font-bold ${retColor(row.retention_pct)}`}>{fmtPct(row.retention_pct)}</span>
      </div>
      <RetBar pct={row.retention_pct} />
      <div className="flex justify-between text-xs text-gray-500 pt-1 border-t border-gray-50 mt-1">
        <span>Atual <span className="font-semibold text-gray-700">{row.quant_atual}</span></span>
        <span>Início <span className="font-semibold text-gray-700">{row.quant_anterior}</span></span>
        <span>Saídas <span className="font-semibold text-red-500">{row.real_churn}</span></span>
      </div>
    </div>
  );
}

function ReasonsChart({ rows, total }: { rows: ReasonRow[]; total: number }) {
  if (!rows.length) return null;
  const max = rows[0].count;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Motivos de rescisão</p>
      <div className="space-y-2.5">
        {rows.map(r => {
          const pct = total > 0 ? Math.round(r.count / total * 100) : 0;
          const isOp = r.reason.toLowerCase().includes("turma não formou");
          return (
            <div key={r.reason}>
              <div className="flex justify-between text-xs mb-0.5">
                <span className={`font-medium ${isOp ? "text-gray-400" : "text-gray-700"}`}>
                  {r.reason}{isOp && <span className="ml-1 text-gray-400">(operacional)</span>}
                </span>
                <span className="text-gray-500 tabular-nums">{r.count} · {pct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{ width: `${Math.round(r.count / max * 100)}%`, backgroundColor: isOp ? "#d1d5db" : "#3b82f6" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function QualityPage() {
  const [data, setData]       = useState<QualityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [renewalData, setRenewalData]     = useState<RenewalData | null>(null);
  const [renewalLoading, setRenewalLoading] = useState(false);

  const [branch, setBranch] = useState("Todas");
  const [start, setStart]   = useState("2026-02-01");
  const [end, setEnd]       = useState(() => new Date().toISOString().slice(0, 10));
  const [tab, setTab]       = useState<Tab>("stage");
  const [search, setSearch] = useState("");
  const [showOp, setShowOp] = useState(true);
  const [renewalStatus, setRenewalStatus] = useState("all");

  const [teacherSort, toggleTeacherSort] = useSort({ key: "teacher",    dir: "asc" });
  const [classSort,   toggleClassSort]   = useSort({ key: "class_name", dir: "asc" });
  const [cancelSort,  toggleCancelSort]  = useSort({ key: "event_date", dir: "desc" });
  const [renewalSort, toggleRenewalSort] = useSort({ key: "name",       dir: "asc" });

  // Quality data fetch
  useEffect(() => {
    setLoading(true); setError(null);
    const p = new URLSearchParams({ start, end, semester: "2026.1", ...(branch !== "Todas" ? { branch } : {}) });
    fetch(`/api/quality?${p}`).then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [branch, start, end]);

  // Renewal data fetch
  useEffect(() => {
    setRenewalLoading(true);
    const p = new URLSearchParams({ semester: "2026.1", ...(branch !== "Todas" ? { branch } : {}) });
    fetch(`/api/renewal?${p}`).then(r => r.json())
      .then(d => { if (!d.error) setRenewalData(d); })
      .catch(() => {})
      .finally(() => setRenewalLoading(false));
  }, [branch]);

  // KPIs
  const kpis = useMemo(() => {
    if (!data) return null;
    const stages = data.byStage;
    const atual = stages.reduce((s, r) => s + r.quant_atual, 0);
    const anterior = stages.reduce((s, r) => s + r.quant_anterior, 0);
    const retPct = anterior > 0 ? Math.round(atual / anterior * 1000) / 10 : null;
    const freqs = data.byClass.map(r => r.avg_freq).filter((v): v is number => v != null);
    const avgFreq = freqs.length ? Math.round(freqs.reduce((a, b) => a + b, 0) / freqs.length * 10) / 10 : null;
    const totalCancel = data.cancels.length;
    const realChurn = data.cancels.filter(r => r.is_real_churn).length;
    return { anterior, atual, retPct, avgFreq, totalCancel, realChurn };
  }, [data]);

  // Teacher rows with retention
  const teacherRows = useMemo(() => {
    if (!data) return [];
    return data.byTeacher.map(r => ({ ...r, retention_pct: calcRet(r.student_count, r.real_churn) }));
  }, [data]);

  // Class rows with retention
  const classRows = useMemo(() => {
    if (!data) return [];
    return data.byClass.map(r => ({ ...r, retention_pct: calcRet(r.student_count, r.real_churn) }));
  }, [data]);

  const filteredTeachers = useMemo(() => sortRows(
    teacherRows.filter(r => !search || r.teacher.toLowerCase().includes(search.toLowerCase())),
    teacherSort
  ), [teacherRows, teacherSort, search]);

  const filteredClasses = useMemo(() => sortRows(
    classRows.filter(r => !search ||
      r.class_name.toLowerCase().includes(search.toLowerCase()) ||
      r.teacher.toLowerCase().includes(search.toLowerCase()) ||
      r.stage.toLowerCase().includes(search.toLowerCase())),
    classSort
  ), [classRows, classSort, search]);

  const filteredCancels = useMemo(() => {
    if (!data) return [];
    return sortRows(
      data.cancels.filter(r => {
        if (!showOp && r.is_turma_nao_formou) return false;
        if (!search) return true;
        return r.student_name.toLowerCase().includes(search.toLowerCase()) ||
          r.class_name.toLowerCase().includes(search.toLowerCase()) ||
          r.reason.toLowerCase().includes(search.toLowerCase()) ||
          r.teacher.toLowerCase().includes(search.toLowerCase());
      }), cancelSort);
  }, [data, cancelSort, search, showOp]);

  const filteredRenewal = useMemo(() => {
    if (!renewalData) return [];
    return sortRows(
      renewalData.detail.filter(r => {
        if (renewalStatus !== "all" && r.status !== renewalStatus) return false;
        if (!search) return true;
        return r.name.toLowerCase().includes(search.toLowerCase()) ||
          r.branch.toLowerCase().includes(search.toLowerCase());
      }), renewalSort);
  }, [renewalData, renewalSort, search, renewalStatus]);

  // Renewal counts
  const renewalCounts = useMemo(() => {
    if (!renewalData) return null;
    const m: Record<string, number> = { Renovado: 0, Pendente: 0, Cancelado: 0 };
    renewalData.summary.forEach(r => { m[r.status] = r.students; });
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    return {
      Renovado:   m.Renovado  || 0,
      Pendente:   m.Pendente  || 0,
      Cancelado:  m.Cancelado || 0,
      total,
      renewalPct: total > 0 ? Math.round((m.Renovado || 0) / total * 100) : 0,
    };
  }, [renewalData]);

  const TABS: { id: Tab; label: string }[] = [
    { id: "stage",   label: "Por Stage" },
    { id: "teacher", label: "Por Professor" },
    { id: "class",   label: "Por Turma" },
    { id: "cancels", label: "Rescisões" },
    { id: "renewal", label: "Renovação" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-5">

      {/* Header + Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Qualidade</h1>
          <p className="text-sm text-gray-500 mt-0.5">Retenção, frequência, rescisões e renovação</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={branch} onChange={e => setBranch(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {BRANCHES.map(b => <option key={b}>{b}</option>)}
          </select>
          {tab !== "renewal" && <>
            <input type="date" value={start} onChange={e => setStart(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <span className="text-gray-400 text-sm">→</span>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </>}
        </div>
      </div>

      {/* Snapshot notice */}
      {data?.snapDates && tab !== "renewal" && (
        <p className="text-xs text-gray-400">
          Período: <span className="font-medium text-gray-600">{data.snapDates.start}</span>
          {" → "}<span className="font-medium text-gray-600">{data.snapDates.end}</span>
          {" · "}Alunos ativos hoje + rescisões no período
        </p>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          Erro ao carregar dados: {error}
        </div>
      )}

      {/* KPI strip — hide on renewal tab */}
      {!loading && kpis && tab !== "renewal" && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {[
            { label: "Alunos (início)", value: String(kpis.anterior) },
            { label: "Alunos (agora)",  value: String(kpis.atual) },
            { label: "Retenção",        value: fmtPct(kpis.retPct),    color: retColor(kpis.retPct) },
            { label: "Freq. Média",     value: fmtPct(kpis.avgFreq),   color: freqColor(kpis.avgFreq) },
            { label: "Rescisões",       value: String(kpis.totalCancel) },
            { label: "Churn real",      value: String(kpis.realChurn), color: kpis.realChurn > 10 ? "text-red-500" : "text-gray-900" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3">
              <p className="text-xs text-gray-500 mb-1">{label}</p>
              <p className={`text-2xl font-bold ${color ?? "text-gray-900"}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch(""); setRenewalStatus("all"); }}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${tab === t.id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
            {t.label}
            {t.id === "cancels" && data && (
              <span className="ml-1.5 bg-red-100 text-red-600 text-xs font-bold px-1.5 py-0.5 rounded-full">
                {data.cancels.filter(r => r.is_real_churn).length}
              </span>
            )}
            {t.id === "renewal" && renewalCounts && renewalCounts.Pendente > 0 && (
              <span className="ml-1.5 bg-amber-100 text-amber-700 text-xs font-bold px-1.5 py-0.5 rounded-full">
                {renewalCounts.Pendente}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Stage tab ── */}
      {tab === "stage" && (
        <>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => <div key={i} className="bg-white rounded-2xl border border-gray-100 h-28 animate-pulse" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data?.byStage.map(r => <StageCard key={r.stage} row={r} />)}
            </div>
          )}
        </>
      )}

      {/* ── Teacher tab ── */}
      {tab === "teacher" && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">{loading ? "…" : `${filteredTeachers.length} professores`}</span>
            <input type="text" placeholder="Buscar professor…" value={search} onChange={e => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <Th label="Professor"  col="teacher"        sort={teacherSort} onSort={toggleTeacherSort} />
                  <Th label="Turmas"     col="class_count"    sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Alunos"     col="student_count"  sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Freq %"     col="avg_freq"       sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Rescisões"  col="real_churn"     sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Retenção %" col="retention_pct"  sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? <Skeleton rows={6} cols={6} /> : filteredTeachers.map(r => (
                  <tr key={r.teacher} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2.5 font-medium text-gray-800">{r.teacher || <span className="text-gray-400 italic">Sem professor</span>}</td>
                    <td className="px-3 py-2.5 text-right text-gray-600">{r.class_count}</td>
                    <td className="px-3 py-2.5 text-right text-gray-600">{r.student_count}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${freqColor(r.avg_freq)}`}>{fmtPct(r.avg_freq)}</td>
                    <td className="px-3 py-2.5 text-right">{r.real_churn > 0 ? <span className="text-red-500 font-semibold">{r.real_churn}</span> : <span className="text-gray-300">0</span>}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${retColor(r.retention_pct)}`}>{fmtPct(r.retention_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && filteredTeachers.length === 0 && <EmptyState />}
        </div>
      )}

      {/* ── Class tab ── */}
      {tab === "class" && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">{loading ? "…" : `${filteredClasses.length} turmas`}</span>
            <input type="text" placeholder="Turma, professor, stage…" value={search} onChange={e => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-56" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <Th label="Turma"      col="class_name"    sort={classSort} onSort={toggleClassSort} />
                  <Th label="Stage"      col="stage"         sort={classSort} onSort={toggleClassSort} />
                  <Th label="Professor"  col="teacher"       sort={classSort} onSort={toggleClassSort} />
                  <Th label="Alunos"     col="student_count" sort={classSort} onSort={toggleClassSort} align="right" />
                  <Th label="Freq %"     col="avg_freq"      sort={classSort} onSort={toggleClassSort} align="right" />
                  <Th label="Rescisões"  col="real_churn"    sort={classSort} onSort={toggleClassSort} align="right" />
                  <Th label="Retenção %" col="retention_pct" sort={classSort} onSort={toggleClassSort} align="right" />
                  {branch === "Todas" && <Th label="Unidade" col="branch" sort={classSort} onSort={toggleClassSort} />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? <Skeleton rows={8} cols={7} /> : filteredClasses.map(r => (
                  <tr key={`${r.branch}-${r.class_name}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">{r.class_name}</td>
                    <td className="px-3 py-2.5"><span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700">{r.stage || "?"}</span></td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{r.teacher || <span className="text-gray-400 italic">—</span>}</td>
                    <td className="px-3 py-2.5 text-right text-gray-600">{r.student_count}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${freqColor(r.avg_freq)}`}>{fmtPct(r.avg_freq)}</td>
                    <td className="px-3 py-2.5 text-right">{r.real_churn > 0 ? <span className="text-red-500 font-semibold">{r.real_churn}</span> : <span className="text-gray-300">0</span>}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${retColor(r.retention_pct)}`}>{fmtPct(r.retention_pct)}</td>
                    {branch === "Todas" && <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{r.branch}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && filteredClasses.length === 0 && <EmptyState />}
        </div>
      )}

      {/* ── Cancels tab ── */}
      {tab === "cancels" && (
        <div className="space-y-4">
          {!loading && data && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ReasonsChart rows={data.reasons} total={data.cancels.length} />
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Resumo</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Total rescisões",  value: data.cancels.length },
                    { label: "Churn real",        value: data.cancels.filter(r => r.is_real_churn).length },
                    { label: "Turma não formou",  value: data.cancels.filter(r => r.is_turma_nao_formou).length },
                    { label: "Motivos distintos", value: data.reasons.length },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-gray-50 rounded-xl p-3">
                      <p className="text-xs text-gray-500">{label}</p>
                      <p className="text-xl font-bold text-gray-900">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-50 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-gray-700">{loading ? "…" : `${filteredCancels.length} rescisões`}</span>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                  <input type="checkbox" checked={showOp} onChange={e => setShowOp(e.target.checked)} className="rounded" />
                  Mostrar "Turma não formou"
                </label>
              </div>
              <input type="text" placeholder="Aluno, turma, motivo, professor…" value={search} onChange={e => setSearch(e.target.value)}
                className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-64" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <Th label="Data"      col="event_date"   sort={cancelSort} onSort={toggleCancelSort} />
                    <Th label="Aluno"     col="student_name" sort={cancelSort} onSort={toggleCancelSort} />
                    <Th label="Turma"     col="class_name"   sort={cancelSort} onSort={toggleCancelSort} />
                    <Th label="Stage"     col="stage"        sort={cancelSort} onSort={toggleCancelSort} />
                    <Th label="Professor" col="teacher"      sort={cancelSort} onSort={toggleCancelSort} />
                    <Th label="Motivo"    col="reason"       sort={cancelSort} onSort={toggleCancelSort} />
                    {branch === "Todas" && <Th label="Unidade" col="branch" sort={cancelSort} onSort={toggleCancelSort} />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {loading ? <Skeleton rows={8} cols={6} /> : filteredCancels.map((r, i) => (
                    <tr key={i} className={`hover:bg-gray-50 transition-colors ${r.is_turma_nao_formou ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap tabular-nums">
                        {new Date(r.event_date + "T12:00:00").toLocaleDateString("pt-BR")}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">{r.student_name}</td>
                      <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{r.class_name}</td>
                      <td className="px-3 py-2.5"><span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700">{r.stage || "?"}</span></td>
                      <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{r.teacher || "—"}</td>
                      <td className="px-3 py-2.5">{r.is_turma_nao_formou ? <span className="text-gray-400 italic">{r.reason}</span> : <span className="text-gray-700">{r.reason}</span>}</td>
                      {branch === "Todas" && <td className="px-3 py-2.5 text-gray-500">{r.branch}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && filteredCancels.length === 0 && <EmptyState />}
          </div>
        </div>
      )}

      {/* ── Renewal tab ── */}
      {tab === "renewal" && (
        <div className="space-y-4">

          {/* Meta info */}
          {renewalData?.meta && (
            <p className="text-xs text-gray-400">
              Baseline: <span className="font-medium text-gray-600">{renewalData.meta.baseline_date}</span>
              {" · "}Checado em: <span className="font-medium text-gray-600">{renewalData.meta.last_checked}</span>
              {" · "}Próximo semestre: <span className="font-medium text-blue-600">{renewalData.meta.next_semester}</span>
            </p>
          )}

          {/* Summary KPIs */}
          {!renewalLoading && renewalCounts && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Total baseline",  value: fmtNum(renewalCounts.total),    color: "text-gray-900" },
                { label: "🟢 Renovado",     value: fmtNum(renewalCounts.Renovado),  color: "text-emerald-600" },
                { label: "🟡 Pendente",     value: fmtNum(renewalCounts.Pendente),  color: "text-amber-600" },
                { label: "🔴 Cancelado",    value: fmtNum(renewalCounts.Cancelado), color: "text-red-500" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3">
                  <p className="text-xs text-gray-500 mb-1">{label}</p>
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Per branch breakdown */}
          {!renewalLoading && renewalData?.byBranch && renewalData.byBranch.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {renewalData.byBranch.map(r => (
                <div key={r.branch} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold text-gray-800">{r.branch}</span>
                    <span className={`text-sm font-bold ${retColor(r.renewal_pct)}`}>
                      {fmtPct(r.renewal_pct)} renovação
                    </span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="flex-1 bg-emerald-50 text-emerald-700 rounded-lg px-2 py-1.5 text-center">
                      <span className="block font-bold text-base">{fmtNum(r.renovado)}</span>Renovado
                    </span>
                    <span className="flex-1 bg-amber-50 text-amber-700 rounded-lg px-2 py-1.5 text-center">
                      <span className="block font-bold text-base">{fmtNum(r.pendente)}</span>Pendente
                    </span>
                    <span className="flex-1 bg-red-50 text-red-600 rounded-lg px-2 py-1.5 text-center">
                      <span className="block font-bold text-base">{fmtNum(r.cancelado)}</span>Cancelado
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Detail table */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-50 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-700">
                  {renewalLoading ? "…" : `${filteredRenewal.length} alunos`}
                </span>
                {/* Status filter buttons */}
                {["all", "Renovado", "Pendente", "Cancelado"].map(s => (
                  <button key={s} onClick={() => setRenewalStatus(s)}
                    className={`text-xs px-2.5 py-1 rounded-full font-medium transition-all ${
                      renewalStatus === s
                        ? s === "all" ? "bg-gray-800 text-white" : STATUS_COLOR[s] + " ring-1 ring-current"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    }`}>
                    {s === "all" ? "Todos" : `${STATUS_DOT[s]} ${s}`}
                  </button>
                ))}
              </div>
              <input type="text" placeholder="Buscar aluno, unidade…" value={search} onChange={e => setSearch(e.target.value)}
                className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-52" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <Th label="Status"  col="status" sort={renewalSort} onSort={toggleRenewalSort} />
                    <Th label="Aluno"   col="name"   sort={renewalSort} onSort={toggleRenewalSort} />
                    {branch === "Todas" && <Th label="Unidade" col="branch" sort={renewalSort} onSort={toggleRenewalSort} />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {renewalLoading ? <Skeleton rows={8} cols={3} /> : filteredRenewal.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50 transition-colors">
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLOR[r.status]}`}>
                          {STATUS_DOT[r.status]} {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-medium text-gray-800">{r.name}</td>
                      {branch === "Todas" && <td className="px-3 py-2.5 text-gray-500">{r.branch}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!renewalLoading && filteredRenewal.length === 0 && <EmptyState />}
          </div>
        </div>
      )}
    </div>
  );
}
