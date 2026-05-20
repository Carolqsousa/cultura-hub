"use client";

import { useEffect, useState, useMemo } from "react";

interface Student {
  student_id: string;
  name: string;
  branch: string;
  class_name: string;
  teacher: string;
  pct_presence: number | null;
  presences: number | null;
  absences: number | null;
  total_lessons: number | null;
  overall_average: number | null;
  grade_format: string | null;
  provas_entered: string | null;
  open_installments: number;
  total_value: number;
}

type RiskLevel = "critical" | "attention" | "ok";
type RiskFilter = "all" | "critical" | "attention" | "grade" | "frequency" | "financial";
type SortKey = keyof Student | "risk_score";

// ── Risk scoring ──────────────────────────────────────────────────────────────
// Priority: Frequency (most critical) > Grade > Installments
//
// Points:
//   Frequency < 50%  → +3
//   Frequency 50–70% → +2
//   Grade < 6        → +2
//   Grade 6–7        → +1
//   Installments > 1 → +2
//   Installments = 1 → +1
//
// Level:
//   🔴 Critical  → score ≥ 4 OR 2+ factors triggered
//   🟡 Attention → score 1–3 (single factor)
//   🟢 OK        → score 0

function calcRisk(s: Student): { level: RiskLevel; score: number; factors: number } {
  let score = 0;
  let factors = 0;

  // Frequency
  if (s.pct_presence !== null) {
    if (s.pct_presence === 0) { score += 10; factors++; } // instant Critical
    else if (s.pct_presence < 50) { score += 3; factors++; }
    else if (s.pct_presence < 70) { score += 2; factors++; }
  }

  // Grade (Format A only)
  if (s.grade_format !== "B" && s.overall_average !== null) {
    if (s.overall_average < 6) { score += 2; factors++; }
    else if (s.overall_average < 7) { score += 1; factors++; }
  }

  // Installments
  if (s.open_installments > 1) { score += 2; factors++; }
  else if (s.open_installments > 0) { score += 1; factors++; }

  const level: RiskLevel =
    score >= 4 || factors >= 2 ? "critical" :
      score >= 1 ? "attention" :
        "ok";

  return { level, score, factors };
}

const RISK_LABEL: Record<RiskLevel, string> = {
  critical: "🔴 Critical",
  attention: "🟡 Attention",
  ok: "🟢 OK",
};

const RISK_CLS: Record<RiskLevel, string> = {
  critical: "bg-red-100 text-red-800 font-semibold",
  attention: "bg-yellow-100 text-yellow-800 font-semibold",
  ok: "text-gray-400",
};

// ── Cell helpers ──────────────────────────────────────────────────────────────

function gradeCell(avg: number | null, format: string | null) {
  if (format === "B") return { label: "N/A", cls: "text-gray-400" };
  if (avg === null) return { label: "—", cls: "text-gray-400" };
  const label = avg.toFixed(1);
  if (avg < 6) return { label, cls: "bg-red-100 text-red-800 font-semibold rounded px-2 py-0.5" };
  if (avg < 7) return { label, cls: "bg-yellow-100 text-yellow-800 font-semibold rounded px-2 py-0.5" };
  return { label, cls: "text-gray-700" };
}

function freqCell(pct: number | null) {
  if (pct === null) return { label: "—", cls: "text-gray-400" };
  const label = `${pct.toFixed(0)}%`;
  if (pct < 50) return { label, cls: "bg-red-100 text-red-800 font-semibold rounded px-2 py-0.5" };
  if (pct < 70) return { label, cls: "bg-yellow-100 text-yellow-800 font-semibold rounded px-2 py-0.5" };
  return { label, cls: "text-gray-700" };
}

function installmentsCell(count: number) {
  if (count === 0) return { label: "—", cls: "text-gray-400" };
  if (count === 1) return { label: "1", cls: "bg-yellow-100 text-yellow-800 font-semibold rounded px-2 py-0.5" };
  return { label: String(count), cls: "bg-red-100 text-red-800 font-semibold rounded px-2 py-0.5" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState("all");
  const [filter, setFilter] = useState<RiskFilter>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("risk_score");
  const [sortAsc, setSortAsc] = useState(false); // highest risk first

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (branch !== "all") params.set("branch", branch);
    fetch(`/api/students?${params}`)
      .then(r => r.json())
      .then(d => { setStudents(d.students || []); setLoading(false); });
  }, [branch]);

  const branches = useMemo(() =>
    ["all", ...Array.from(new Set(students.map(s => s.branch))).sort()],
    [students]
  );

  // Enrich students with risk level
  const enriched = useMemo(() =>
    students.map(s => ({ ...s, ...calcRisk(s) })),
    [students]
  );

  // Summary counts
  const counts = useMemo(() => ({
    total: enriched.length,
    critical: enriched.filter(s => s.level === "critical").length,
    attention: enriched.filter(s => s.level === "attention").length,
    ok: enriched.filter(s => s.level === "ok").length,
  }), [enriched]);

  const filtered = useMemo(() => {
    let rows = enriched.filter(s => {
      if (filter === "critical") return s.level === "critical";
      if (filter === "attention") return s.level === "attention";
      if (filter === "grade") return s.grade_format !== "B" && s.overall_average !== null && s.overall_average < 7;
      if (filter === "frequency") return s.pct_presence !== null && s.pct_presence < 70;
      if (filter === "financial") return s.open_installments > 0;
      return true;
    });

    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.class_name?.toLowerCase().includes(q) ||
        s.teacher?.toLowerCase().includes(q)
      );
    }

    const LEVEL_ORDER: Record<RiskLevel, number> = { critical: 0, attention: 1, ok: 2 };

    rows = [...rows].sort((a, b) => {
      if (sortKey === "risk_score") {
        // Always sort by level first (Critical→Attention→OK), then by score within level
        const levelCmp = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
        if (levelCmp !== 0) return sortAsc ? -levelCmp : levelCmp;
        return sortAsc ? a.score - b.score : b.score - a.score;
      }
      const av: any = (a as any)[sortKey] ?? "";
      const bv: any = (b as any)[sortKey] ?? "";
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });

    return rows;
  }, [enriched, filter, search, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(key !== "risk_score"); }
  }

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    return (
      <th
        onClick={() => toggleSort(k)}
        className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800"
      >
        {label}{sortKey === k ? (sortAsc ? " ↑" : " ↓") : ""}
      </th>
    );
  }

  return (
    <main className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Alunos</h1>
        <p className="text-sm text-gray-500 mt-1">
          Frequência atualizada aos domingos · Notas e financeiro: Seg/Qua/Sex
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Ativos", value: counts.total, color: "text-gray-900", f: "all" },
          { label: "🔴 Critical", value: counts.critical, color: "text-red-700", f: "critical" },
          { label: "🟡 Attention", value: counts.attention, color: "text-yellow-700", f: "attention" },
          { label: "🟢 OK", value: counts.ok, color: "text-green-700", f: "all" },
        ].map(c => (
          <button
            key={c.label}
            onClick={() => setFilter(c.f as RiskFilter)}
            className={`bg-white rounded-xl border p-4 text-left transition-colors hover:border-blue-400 ${filter === c.f && c.f !== "all" ? "border-blue-400 ring-1 ring-blue-400" : "border-gray-200"
              }`}
          >
            <p className="text-xs text-gray-500 font-medium">{c.label}</p>
            <p className={`text-3xl font-bold mt-1 ${c.color}`}>{c.value}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={branch}
          onChange={e => setBranch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {branches.map(b => (
            <option key={b} value={b}>{b === "all" ? "Todas as unidades" : b}</option>
          ))}
        </select>

        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {([
            ["all", "Todos"],
            ["critical", "🔴 Critical"],
            ["attention", "🟡 Attention"],
            ["grade", "Nota"],
            ["frequency", "Frequência"],
            ["financial", "Financeiro"],
          ] as [RiskFilter, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${filter === val
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
                }`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Buscar aluno, turma ou professor..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-72 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <span className="text-sm text-gray-400 ml-auto">
          {filtered.length} aluno{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-400">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-gray-400">Nenhum aluno encontrado</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <SortTh label="Risco" k="risk_score" />
                  <SortTh label="Aluno" k="name" />
                  <SortTh label="Unidade" k="branch" />
                  <SortTh label="Turma" k="class_name" />
                  <SortTh label="Professor" k="teacher" />
                  <SortTh label="Frequência" k="pct_presence" />
                  <SortTh label="Des. Escolar" k="overall_average" />
                  <SortTh label="Parc. Aberto" k="open_installments" />
                  <SortTh label="Valor (R$)" k="total_value" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(s => {
                  const grade = gradeCell(s.overall_average, s.grade_format);
                  const freq = freqCell(s.pct_presence);
                  const instal = installmentsCell(s.open_installments);
                  return (
                    <tr key={`${s.student_id}-${s.class_name}`} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5">
                        <span className={`text-xs rounded px-2 py-0.5 ${RISK_CLS[s.level]}`}>
                          {RISK_LABEL[s.level]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-medium text-gray-900 whitespace-nowrap">{s.name}</td>
                      <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{s.branch}</td>
                      <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{s.class_name}</td>
                      <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{s.teacher || "—"}</td>
                      <td className="px-3 py-2.5">
                        <span className={freq.cls}>{freq.label}</span>
                        {s.pct_presence !== null && (
                          <span className="text-xs text-gray-400 ml-1">({s.presences}/{s.total_lessons})</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={grade.cls}>{grade.label}</span>
                        {s.provas_entered && s.grade_format !== "B" && (
                          <span className="text-xs text-gray-400 ml-1">
                            {s.provas_entered.split(",").length}/3
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={instal.cls}>{instal.label}</span>
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {s.total_value > 0
                          ? `R$ ${s.total_value.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
