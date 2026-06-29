"use client";
// dashboard/app/(dashboard)/history/page.tsx
// Semester-over-semester comparison using retention_history snapshots.

import { useState, useEffect, useMemo } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SemesterMeta {
  semester: string;
  snapshot_type: string;
  snapshot_date: string;
  is_estimated: boolean;
}

interface GlobalRow {
  semester: string;
  snapshot_date: string;
  snapshot_type: string;
  is_estimated: boolean;
  branch: string;
  student_count: number;
  real_churn: number;
  total_churn: number;
  retention_pct: number | null;
  avg_freq: number | null;
  total_revenue: number;
  total_paid: number;
  total_overdue: number;
}

interface StageRow {
  semester: string;
  branch: string;
  stage: string;
  student_count: number;
  real_churn: number;
  retention_pct: number | null;
  is_estimated: boolean;
}

interface TeacherRow {
  semester: string;
  teacher: string;
  class_count: number;
  student_count: number;
  real_churn: number;
  retention_pct: number | null;
  avg_freq: number | null;
  is_estimated: boolean;
}

interface ClassRow {
  semester: string;
  branch: string;
  class_name: string;
  stage: string;
  teacher: string;
  student_count: number;
  real_churn: number;
  retention_pct: number | null;
  avg_freq: number | null;
  is_estimated: boolean;
}

interface HistoryData {
  semesters: SemesterMeta[];
  global: GlobalRow[];
  detail: (StageRow | TeacherRow | ClassRow)[];
  dimension: string;
  snap_type: string;
}

const BRANCHES   = ["Todas", "Boa Viagem", "Young", "Setubal", "Natal"];
const SNAP_TYPES = [
  { id: "end",   label: "Fim de semestre" },
  { id: "mid",   label: "Meio de semestre" },
  { id: "start", label: "Início de semestre" },
];
type Dimension = "global" | "stage" | "teacher" | "class";
type SortDir   = "asc" | "desc";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPct  = (v: number | null) => v == null ? "—" : `${Number(v).toFixed(1)}%`;
const fmtNum  = (v: number) => v.toLocaleString("pt-BR");
const fmtR    = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const retColor = (v: number | null) =>
  v == null ? "text-gray-400" : v >= 90 ? "text-emerald-600" : v >= 75 ? "text-amber-500" : "text-red-500";
const freqColor = (v: number | null) =>
  v == null ? "text-gray-400" : v >= 85 ? "text-emerald-600" : v >= 70 ? "text-amber-500" : "text-red-500";

function pctChange(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a === 0) return null;
  return Math.round((b - a) / a * 100);
}

function Delta({ from, to, inverse = false, suffix = "%" }: {
  from: number | null; to: number | null; inverse?: boolean; suffix?: string;
}) {
  const chg = pctChange(from, to);
  if (chg === null || chg === 0) return null;
  const good = inverse ? chg < 0 : chg > 0;
  return (
    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${
      good ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"
    }`}>
      {chg > 0 ? "↑" : "↓"}{Math.abs(chg)}{suffix}
    </span>
  );
}

type SortState = { key: string; dir: SortDir };
function useSort(init: SortState) {
  const [s, set] = useState(init);
  const toggle = (k: string) => set(prev => ({ key: k, dir: prev.key === k && prev.dir === "asc" ? "desc" : "asc" }));
  return [s, toggle] as const;
}
function sortRows<T>(rows: T[], s: SortState): T[] {
  return [...rows].sort((a, b) => {
    const av = (a as any)[s.key] ?? "";
    const bv = (b as any)[s.key] ?? "";
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
      className={`px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide
        cursor-pointer select-none whitespace-nowrap hover:text-gray-800
        ${align === "right" ? "text-right" : "text-left"}`}>
      {label} {active ? (sort.dir === "asc" ? "↑" : "↓") : <span className="text-gray-300">↕</span>}
    </th>
  );
}

function Skeleton({ rows = 4, cols = 6 }) {
  return <>
    {Array.from({ length: rows }).map((_, i) => (
      <tr key={i}>{Array.from({ length: cols }).map((_, j) => (
        <td key={j} className="px-3 py-3">
          <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
        </td>
      ))}</tr>
    ))}
  </>;
}

// ─── Semester comparison card ─────────────────────────────────────────────────

function SemesterCard({
  label, current, previous, isEstimated
}: {
  label: string;
  current: GlobalRow[];
  previous: GlobalRow[] | null;
  isEstimated: boolean;
}) {
  const totals = (rows: GlobalRow[]) => ({
    students:  rows.reduce((s, r) => s + r.student_count, 0),
    churn:     rows.reduce((s, r) => s + r.real_churn, 0),
    revenue:   rows.reduce((s, r) => s + r.total_revenue, 0),
    paid:      rows.reduce((s, r) => s + r.total_paid, 0),
    overdue:   rows.reduce((s, r) => s + r.total_overdue, 0),
    retention: rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + (r.retention_pct ?? 0), 0) / rows.length * 10) / 10
      : null,
  });

  const cur  = totals(current);
  const prev = previous ? totals(previous) : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-800">{label}</h3>
        {isEstimated && (
          <span className="text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full">
            estimado
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "Alunos", value: fmtNum(cur.students), prev: prev?.students ?? null, cur: cur.students },
          { label: "Churn real", value: fmtNum(cur.churn), prev: prev?.churn ?? null, cur: cur.churn, inverse: true },
          { label: "Retenção", value: fmtPct(cur.retention), color: retColor(cur.retention), prev: prev?.retention ?? null, cur: cur.retention },
          { label: "Receita", value: fmtR(cur.revenue), prev: prev?.revenue ?? null, cur: cur.revenue },
          { label: "Recebido", value: fmtR(cur.paid), prev: prev?.paid ?? null, cur: cur.paid },
          { label: "Em atraso", value: fmtR(cur.overdue), prev: prev?.overdue ?? null, cur: cur.overdue, inverse: true, color: cur.overdue > 0 ? "text-red-500" : "text-gray-900" },
        ].map(({ label: l, value, prev: p, cur: c, inverse, color }) => (
          <div key={l} className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs text-gray-500 mb-1">{l}</p>
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className={`text-lg font-bold ${color ?? "text-gray-900"}`}>{value}</span>
              <Delta from={p} to={c} inverse={inverse} suffix="%" />
            </div>
          </div>
        ))}
      </div>

      {/* Per branch breakdown */}
      <div className="border-t border-gray-50 pt-3 space-y-2">
        {current.map(r => (
          <div key={r.branch} className="flex items-center justify-between text-xs">
            <span className="text-gray-500 w-24">{r.branch}</span>
            <span className="text-gray-700 font-medium">{fmtNum(r.student_count)} alunos</span>
            <span className={`font-semibold ${retColor(r.retention_pct)}`}>{fmtPct(r.retention_pct)}</span>
            <span className="text-gray-400">{fmtR(r.total_revenue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const [data, setData]       = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [branch,    setBranch]    = useState("Todas");
  const [snapType,  setSnapType]  = useState("end");
  const [dimension, setDimension] = useState<Dimension>("global");
  const [search,    setSearch]    = useState("");

  const [stageSort,   toggleStageSort]   = useSort({ key: "semester",   dir: "asc" });
  const [teacherSort, toggleTeacherSort] = useSort({ key: "teacher",    dir: "asc" });
  const [classSort,   toggleClassSort]   = useSort({ key: "class_name", dir: "asc" });

  useEffect(() => {
    setLoading(true); setError(null);
    const p = new URLSearchParams({
      dimension,
      snap_type: snapType,
      ...(branch !== "Todas" ? { branch } : {}),
    });
    fetch(`/api/history?${p}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [branch, snapType, dimension]);

  // Group global data by semester
  const bySemester = useMemo(() => {
    if (!data) return {};
    const map: Record<string, GlobalRow[]> = {};
    for (const r of data.global) {
      if (!map[r.semester]) map[r.semester] = [];
      map[r.semester].push(r);
    }
    return map;
  }, [data]);

  const semesters = Object.keys(bySemester).sort();

  // Filtered detail rows
  const detailRows = useMemo(() => {
    if (!data?.detail) return [];
    const filtered = data.detail.filter(r => {
      if (!search) return true;
      return Object.values(r).some(v =>
        String(v).toLowerCase().includes(search.toLowerCase())
      );
    });
    if (dimension === "stage")   return sortRows(filtered as StageRow[],   stageSort);
    if (dimension === "teacher") return sortRows(filtered as TeacherRow[], teacherSort);
    if (dimension === "class")   return sortRows(filtered as ClassRow[],   classSort);
    return filtered;
  }, [data, search, dimension, stageSort, teacherSort, classSort]);

  const DIMS: { id: Dimension; label: string }[] = [
    { id: "global",  label: "Global" },
    { id: "stage",   label: "Por Stage" },
    { id: "teacher", label: "Por Professor" },
    { id: "class",   label: "Por Turma" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-5">

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Histórico</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Comparação semestre a semestre — retenção, churn, frequência e receita
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={branch} onChange={e => setBranch(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {BRANCHES.map(b => <option key={b}>{b}</option>)}
          </select>
          <select value={snapType} onChange={e => setSnapType(e.target.value)}
            className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {SNAP_TYPES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          Erro: {error}
        </div>
      )}

      {/* Dimension tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {DIMS.map(d => (
          <button key={d.id} onClick={() => { setDimension(d.id); setSearch(""); }}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all
              ${dimension === d.id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
            {d.label}
          </button>
        ))}
      </div>

      {/* ── Global view ── */}
      {dimension === "global" && (
        <>
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-white rounded-2xl border border-gray-100 h-64 animate-pulse" />
              ))}
            </div>
          ) : semesters.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <p className="text-3xl mb-2">📭</p>
              <p className="text-sm">Nenhum snapshot disponível ainda.</p>
              <p className="text-xs mt-1 text-gray-300">
                O primeiro snapshot de fim de semestre será capturado em 29/06/2026.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {semesters.map((sem, i) => (
                <SemesterCard
                  key={sem}
                  label={sem}
                  current={bySemester[sem]}
                  previous={i > 0 ? bySemester[semesters[i - 1]] : null}
                  isEstimated={bySemester[sem].some(r => r.is_estimated)}
                />
              ))}
            </div>
          )}

          {/* Financial note */}
          {!loading && semesters.length > 0 && (
            <p className="text-xs text-gray-400">
              ⓘ Dados financeiros disponíveis a partir de maio/2026.
              Receita de 2026.1 é parcial.
            </p>
          )}
        </>
      )}

      {/* ── Stage view ── */}
      {dimension === "stage" && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">
              {loading ? "…" : `${detailRows.length} linhas`}
            </span>
            <input type="text" placeholder="Buscar stage, semestre…" value={search}
              onChange={e => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <Th label="Semestre"   col="semester"       sort={stageSort} onSort={toggleStageSort} />
                  <Th label="Stage"      col="stage"          sort={stageSort} onSort={toggleStageSort} />
                  {branch === "Todas" && <Th label="Unidade" col="branch" sort={stageSort} onSort={toggleStageSort} />}
                  <Th label="Alunos"     col="student_count"  sort={stageSort} onSort={toggleStageSort} align="right" />
                  <Th label="Churn"      col="real_churn"     sort={stageSort} onSort={toggleStageSort} align="right" />
                  <Th label="Retenção %" col="retention_pct"  sort={stageSort} onSort={toggleStageSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? <Skeleton rows={6} cols={5} /> : (detailRows as StageRow[]).map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2.5 font-medium text-gray-800">
                      {r.semester}
                      {r.is_estimated && <span className="ml-1 text-xs text-amber-500">~</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700">
                        {r.stage}
                      </span>
                    </td>
                    {branch === "Todas" && <td className="px-3 py-2.5 text-gray-500">{r.branch}</td>}
                    <td className="px-3 py-2.5 text-right text-gray-700">{fmtNum(r.student_count)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {r.real_churn > 0
                        ? <span className="text-red-500 font-semibold">{r.real_churn}</span>
                        : <span className="text-gray-300">0</span>}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${retColor(r.retention_pct)}`}>
                      {fmtPct(r.retention_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Teacher view ── */}
      {dimension === "teacher" && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">
              {loading ? "…" : `${detailRows.length} linhas`}
            </span>
            <input type="text" placeholder="Buscar professor, semestre…" value={search}
              onChange={e => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <Th label="Semestre"   col="semester"      sort={teacherSort} onSort={toggleTeacherSort} />
                  <Th label="Professor"  col="teacher"       sort={teacherSort} onSort={toggleTeacherSort} />
                  <Th label="Turmas"     col="class_count"   sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Alunos"     col="student_count" sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Freq %"     col="avg_freq"      sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Churn"      col="real_churn"    sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                  <Th label="Retenção %" col="retention_pct" sort={teacherSort} onSort={toggleTeacherSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? <Skeleton rows={6} cols={7} /> : (detailRows as TeacherRow[]).map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2.5 font-medium text-gray-800">
                      {r.semester}
                      {r.is_estimated && <span className="ml-1 text-xs text-amber-500">~</span>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-800">{r.teacher}</td>
                    <td className="px-3 py-2.5 text-right text-gray-600">{r.class_count}</td>
                    <td className="px-3 py-2.5 text-right text-gray-700">{fmtNum(r.student_count)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${freqColor(r.avg_freq)}`}>
                      {fmtPct(r.avg_freq)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {r.real_churn > 0
                        ? <span className="text-red-500 font-semibold">{r.real_churn}</span>
                        : <span className="text-gray-300">0</span>}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${retColor(r.retention_pct)}`}>
                      {fmtPct(r.retention_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Class view ── */}
      {dimension === "class" && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">
              {loading ? "…" : `${detailRows.length} linhas`}
            </span>
            <input type="text" placeholder="Buscar turma, professor, stage…" value={search}
              onChange={e => setSearch(e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-56" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <Th label="Semestre"   col="semester"      sort={classSort} onSort={toggleClassSort} />
                  <Th label="Turma"      col="class_name"    sort={classSort} onSort={toggleClassSort} />
                  <Th label="Stage"      col="stage"         sort={classSort} onSort={toggleClassSort} />
                  <Th label="Professor"  col="teacher"       sort={classSort} onSort={toggleClassSort} />
                  {branch === "Todas" && <Th label="Unidade" col="branch" sort={classSort} onSort={toggleClassSort} />}
                  <Th label="Alunos"     col="student_count" sort={classSort} onSort={toggleClassSort} align="right" />
                  <Th label="Freq %"     col="avg_freq"      sort={classSort} onSort={toggleClassSort} align="right" />
                  <Th label="Churn"      col="real_churn"    sort={classSort} onSort={toggleClassSort} align="right" />
                  <Th label="Retenção %" col="retention_pct" sort={classSort} onSort={toggleClassSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? <Skeleton rows={8} cols={8} /> : (detailRows as ClassRow[]).map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">
                      {r.semester}
                      {r.is_estimated && <span className="ml-1 text-xs text-amber-500">~</span>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-800 whitespace-nowrap">{r.class_name}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-blue-50 text-blue-700">
                        {r.stage || "?"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{r.teacher || "—"}</td>
                    {branch === "Todas" && <td className="px-3 py-2.5 text-gray-500">{r.branch}</td>}
                    <td className="px-3 py-2.5 text-right text-gray-700">{fmtNum(r.student_count)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${freqColor(r.avg_freq)}`}>
                      {fmtPct(r.avg_freq)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {r.real_churn > 0
                        ? <span className="text-red-500 font-semibold">{r.real_churn}</span>
                        : <span className="text-gray-300">0</span>}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${retColor(r.retention_pct)}`}>
                      {fmtPct(r.retention_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
