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

type RiskFilter = "all" | "grade" | "frequency" | "financial" | "any";
type SortKey = keyof Student;

// ── Color helpers ─────────────────────────────────────────────────────────────

function gradeCell(avg: number | null, format: string | null) {
  if (format === "B") return { label: "N/A", cls: "text-gray-400" };
  if (avg === null)   return { label: "—",   cls: "text-gray-400" };
  const label = avg.toFixed(1);
  if (avg < 6)  return { label, cls: "bg-red-100 text-red-800 font-semibold rounded px-2 py-0.5" };
  if (avg < 7)  return { label, cls: "bg-yellow-100 text-yellow-800 font-semibold rounded px-2 py-0.5" };
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
  if (count === 0) return { label: "0", cls: "text-gray-400" };
  if (count === 1) return { label: "1", cls: "bg-yellow-100 text-yellow-800 font-semibold rounded px-2 py-0.5" };
  return { label: String(count), cls: "bg-red-100 text-red-800 font-semibold rounded px-2 py-0.5" };
}

function isAtRisk(s: Student, filter: RiskFilter): boolean {
  const gradeRisk  = s.grade_format !== "B" && s.overall_average !== null && s.overall_average < 7;
  const freqRisk   = s.pct_presence !== null && s.pct_presence < 70;
  const finRisk    = s.open_installments > 0;
  if (filter === "grade")     return gradeRisk;
  if (filter === "frequency") return freqRisk;
  if (filter === "financial") return finRisk;
  if (filter === "any")       return gradeRisk || freqRisk || finRisk;
  return true;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StudentsPage() {
  const [students, setStudents]   = useState<Student[]>([]);
  const [loading, setLoading]     = useState(true);
  const [branch, setBranch]       = useState("all");
  const [risk, setRisk]           = useState<RiskFilter>("all");
  const [search, setSearch]       = useState("");
  const [sortKey, setSortKey]     = useState<SortKey>("name");
  const [sortAsc, setSortAsc]     = useState(true);

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

  const filtered = useMemo(() => {
    let rows = students.filter(s => isAtRisk(s, risk));
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.class_name?.toLowerCase().includes(q) ||
        s.teacher?.toLowerCase().includes(q)
      );
    }
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [students, risk, search, sortKey, sortAsc]);

  // Summary counts
  const counts = useMemo(() => ({
    total:     students.length,
    grade:     students.filter(s => isAtRisk(s, "grade")).length,
    frequency: students.filter(s => isAtRisk(s, "frequency")).length,
    financial: students.filter(s => isAtRisk(s, "financial")).length,
  }), [students]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  }

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    return (
      <th
        onClick={() => toggleSort(k)}
        className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800"
      >
        {label} {sortKey === k ? (sortAsc ? "↑" : "↓") : ""}
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
          { label: "Total Ativos",         value: counts.total,     color: "text-gray-900", onClick: () => setRisk("all") },
          { label: "⚠️ Nota < 7",          value: counts.grade,     color: "text-yellow-700", onClick: () => setRisk("grade") },
          { label: "⚠️ Frequência < 70%",  value: counts.frequency, color: "text-yellow-700", onClick: () => setRisk("frequency") },
          { label: "⚠️ Parc. em Aberto",   value: counts.financial, color: "text-yellow-700", onClick: () => setRisk("financial") },
        ].map(c => (
          <button
            key={c.label}
            onClick={c.onClick}
            className="bg-white rounded-xl border border-gray-200 p-4 text-left hover:border-blue-400 transition-colors"
          >
            <p className="text-xs text-gray-500 font-medium">{c.label}</p>
            <p className={`text-3xl font-bold mt-1 ${c.color}`}>{c.value}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Branch */}
        <select
          value={branch}
          onChange={e => setBranch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {branches.map(b => (
            <option key={b} value={b}>{b === "all" ? "Todas as unidades" : b}</option>
          ))}
        </select>

        {/* Risk filter */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {([
            ["all",       "Todos"],
            ["any",       "Em risco"],
            ["grade",     "Nota"],
            ["frequency", "Frequência"],
            ["financial", "Financeiro"],
          ] as [RiskFilter, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setRisk(val)}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                risk === val
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search */}
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
                  <SortTh label="Aluno"       k="name" />
                  <SortTh label="Unidade"     k="branch" />
                  <SortTh label="Turma"       k="class_name" />
                  <SortTh label="Professor"   k="teacher" />
                  <SortTh label="Frequência"  k="pct_presence" />
                  <SortTh label="Des. Escolar" k="overall_average" />
                  <SortTh label="Parc. Aberto" k="open_installments" />
                  <SortTh label="Valor (R$)"  k="total_value" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(s => {
                  const grade  = gradeCell(s.overall_average, s.grade_format);
                  const freq   = freqCell(s.pct_presence);
                  const instal = installmentsCell(s.open_installments);
                  return (
                    <tr key={`${s.student_id}-${s.class_name}`} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-900">{s.name}</td>
                      <td className="px-3 py-2.5 text-gray-500">{s.branch}</td>
                      <td className="px-3 py-2.5 text-gray-600">{s.class_name}</td>
                      <td className="px-3 py-2.5 text-gray-500">{s.teacher || "—"}</td>
                      <td className="px-3 py-2.5">
                        <span className={freq.cls}>{freq.label}</span>
                        {s.pct_presence !== null && (
                          <span className="text-xs text-gray-400 ml-1">
                            ({s.presences}/{s.total_lessons})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={grade.cls}>{grade.label}</span>
                        {s.provas_entered && s.grade_format !== "B" && (
                          <span className="text-xs text-gray-400 ml-1">
                            {s.provas_entered.split(",").length}/3 provas
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
