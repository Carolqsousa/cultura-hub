"use client";

import { useEffect, useState, useMemo } from "react";

interface DiaryBranch {
  branch: string;
  total_lessons: number;
  completed: number;
  pending: number;
  pct_complete: number;
}

interface DiaryTeacher {
  professor: string;
  branch: string;
  classes: number;
  total_lessons: number;
  completed: number;
  pending: number;
  pct_complete: number;
}

interface FinancialRow {
  branch: string;
  students_behind: number;
  total_parcels: number;
  total_value_due: number;
}

type SortKey = "professor" | "branch" | "classes" | "total_lessons" | "completed" | "pending" | "pct_complete";

export default function OverviewPage() {
  const [diary, setDiary] = useState<DiaryBranch[]>([]);
  const [teachers, setTeachers] = useState<DiaryTeacher[]>([]);
  const [financials, setFinancials] = useState<FinancialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState("");

  const [filterProf, setFilterProf] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterBranch, setFilterBranch] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("pending");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    fetch("/api/overview")
      .then(r => r.json())
      .then(d => {
        setDiary(d.diary || []);
        setTeachers(d.teachers || []);
        setFinancials(d.financials || []);
        setUpdatedAt(d.updated_at || "");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const totalPending        = diary.reduce((s, r) => s + Number(r.pending), 0);
  const totalLessons        = diary.reduce((s, r) => s + Number(r.total_lessons), 0);
  const totalCompleted      = diary.reduce((s, r) => s + Number(r.completed), 0);
  const overallPct          = totalLessons > 0 ? Math.round(totalCompleted / totalLessons * 100) : 0;
  const totalStudentsBehind = financials.reduce((s, r) => s + Number(r.students_behind), 0);
  const totalValueDue       = financials.reduce((s, r) => s + Number(r.total_value_due), 0);

  const professors = useMemo(() => ["all", ...Array.from(new Set(teachers.map(t => t.professor))).sort()], [teachers]);
  const branches   = useMemo(() => ["all", ...Array.from(new Set(teachers.map(t => t.branch))).sort()], [teachers]);

  const filteredSortedTeachers = useMemo(() => {
    const filtered = teachers.filter(r => {
      const p = Number(r.pct_complete);
      if (filterProf !== "all" && r.professor !== filterProf) return false;
      if (filterBranch !== "all" && r.branch !== filterBranch) return false;
      if (filterStatus === "ok" && p < 100) return false;
      if (filterStatus === "attention" && (p < 70 || p === 100)) return false;
      if (filterStatus === "critical" && p >= 70) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (typeof va === "string") return sortAsc ? va.localeCompare(vb as string) : (vb as string).localeCompare(va);
      return sortAsc ? Number(va) - Number(vb) : Number(vb) - Number(va);
    });
  }, [teachers, filterProf, filterStatus, filterBranch, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(key === "professor" || key === "branch"); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="ml-1 text-gray-300 text-xs">↕</span>;
    return <span className="ml-1 text-gray-600 text-xs">{sortAsc ? "↑" : "↓"}</span>;
  }

  function Th({ label, k, center }: { label: string; k: SortKey; center?: boolean }) {
    return (
      <th
        className={`pb-2 cursor-pointer select-none hover:text-gray-600 whitespace-nowrap ${center ? "text-center" : ""}`}
        onClick={() => handleSort(k)}
      >
        {label}<SortIcon k={k} />
      </th>
    );
  }

  if (loading) return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Cultura Hub</h1>
      <p className="text-sm text-gray-400 mt-4">Carregando dados...</p>
    </main>
  );

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Cultura Hub</h1>
      <p className="text-sm text-gray-500 mb-8">Visão geral — todas as unidades</p>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <MetricCard label="Diários pendentes" value={String(totalPending)} color={totalPending > 0 ? "text-orange-500" : "text-green-600"} />
        <MetricCard label="% diário OK" value={`${overallPct}%`} color={overallPct >= 90 ? "text-green-600" : "text-orange-500"} />
        <MetricCard label="Inadimplentes" value={totalStudentsBehind.toLocaleString("pt-BR")} color="text-red-500" />
        <MetricCard label="Valor em aberto" value={`R$ ${totalValueDue.toLocaleString("pt-BR", {minimumFractionDigits:0,maximumFractionDigits:0})}`} color="text-red-600" />
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card title="Diário de aula por unidade">
          {diary.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
          {diary.map(r => (
            <BranchRow key={r.branch} name={r.branch} pct={Number(r.pct_complete)} pending={Number(r.pending)} />
          ))}
        </Card>

        <Card title="Inadimplência por unidade">
          {financials.length === 0 && <p className="text-sm text-gray-400">Sem dados</p>}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="pb-2">Unidade</th>
                <th className="pb-2 text-center">Alunos</th>
                <th className="pb-2 text-center">Parcelas</th>
                <th className="pb-2 text-right">Valor em aberto</th>
              </tr>
            </thead>
            <tbody>
              {financials.map((r, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 font-medium">{r.branch}</td>
                  <td className="py-2 text-center text-red-500 font-medium">{Number(r.students_behind)}</td>
                  <td className="py-2 text-center text-gray-500">{Number(r.total_parcels)}</td>
                  <td className="py-2 text-right font-medium text-red-600">
                    R$ {Number(r.total_value_due).toLocaleString("pt-BR", {minimumFractionDigits:2,maximumFractionDigits:2})}
                  </td>
                </tr>
              ))}
              <tr className="bg-gray-50 font-semibold">
                <td className="py-2">Total</td>
                <td className="py-2 text-center text-red-500">{totalStudentsBehind}</td>
                <td className="py-2 text-center text-gray-500">{financials.reduce((s,r) => s+Number(r.total_parcels),0)}</td>
                <td className="py-2 text-right text-red-600">
                  R$ {totalValueDue.toLocaleString("pt-BR", {minimumFractionDigits:2,maximumFractionDigits:2})}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card title="Matrículas vs meta — 2026.1">
          <GoalRow name="Boa Viagem" current={48} goal={60} />
          <GoalRow name="Young" current={31} goal={40} />
          <GoalRow name="Setubal" current={22} goal={30} />
          <GoalRow name="Natal" current={19} goal={25} />
        </Card>
        <Card title="Alunos em risco">
          <p className="text-sm text-gray-400">Em breve — aguardando dados de frequência e notas</p>
        </Card>
      </div>

      {/* Teacher diary with filters + sortable columns */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-sm font-semibold text-gray-700">Diário por professor {updatedAt && <span className="text-xs text-gray-400 font-normal ml-2">· atualizado {updatedAt}</span>}</h2> {updatedAt && <span className="text-xs text-gray-400 font-normal ml-2">atualizado {updatedAt}</span>}
          <div className="flex gap-2 flex-wrap items-center">
            <select value={filterBranch} onChange={e => setFilterBranch(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 outline-none">
              <option value="all">Todas as unidades</option>
              {branches.filter(b => b !== "all").map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={filterProf} onChange={e => setFilterProf(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 outline-none">
              <option value="all">Todos os professores</option>
              {professors.filter(p => p !== "all").map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 outline-none">
              <option value="all">Todos os status</option>
              <option value="ok">Em dia (100%)</option>
              <option value="attention">Atenção (70–99%)</option>
              <option value="critical">Crítico (&lt;70%)</option>
            </select>
            <span className="text-xs text-gray-400">
              {filteredSortedTeachers.length} professor{filteredSortedTeachers.length !== 1 ? "es" : ""}
            </span>
          </div>
        </div>

        {filteredSortedTeachers.length === 0
          ? <p className="text-sm text-gray-400 py-4 text-center">Nenhum professor encontrado.</p>
          : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b">
                  <Th label="Professor" k="professor" />
                  <Th label="Unidade" k="branch" />
                  <Th label="Turmas" k="classes" center />
                  <Th label="Aulas" k="total_lessons" center />
                  <Th label="OK" k="completed" center />
                  <Th label="Pendentes" k="pending" center />
                  <Th label="Preenchimento" k="pct_complete" />
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedTeachers.map((r, i) => {
                  const p    = Number(r.pct_complete);
                  const pend = Number(r.pending);
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 font-medium">{r.professor}</td>
                      <td className="py-2 text-gray-500">{r.branch}</td>
                      <td className="py-2 text-center">{Number(r.classes)}</td>
                      <td className="py-2 text-center">{Number(r.total_lessons)}</td>
                      <td className="py-2 text-center text-green-600">{Number(r.completed)}</td>
                      <td className={`py-2 text-center font-medium ${pend > 0 ? "text-red-500" : "text-gray-400"}`}>{pend}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                            <div className="h-1.5 rounded-full"
                              style={{width:`${p}%`, background: p===100?"#1D9E75":p>=70?"#EF9F27":"#E24B4A"}} />
                          </div>
                          <span style={{color:p===100?"#1D9E75":p>=70?"#BA7517":"#A32D2D"}}
                            className="text-xs font-medium min-w-[34px] text-right">{p}%</span>
                        </div>
                      </td>
                      <td className="py-2">
                        {p === 100
                          ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Em dia</span>
                          : p >= 70
                            ? <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">Atenção</span>
                            : <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Crítico</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        }
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

function BranchRow({ name, pct, pending }: { name: string; pct: number; pending: number }) {
  const color = pct === 100 ? "bg-green-500" : pct >= 70 ? "bg-orange-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-sm w-24 shrink-0">{name}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-medium w-10 text-right">{pct}%</span>
      {pending > 0
        ? <span className="text-xs text-red-500 w-16">{pending} pend.</span>
        : <span className="text-xs text-green-500 w-16">Em dia</span>}
    </div>
  );
}

function GoalRow({ name, current, goal }: { name: string; current: number; goal: number }) {
  const pct   = Math.round(current / goal * 100);
  const color = pct >= 100 ? "bg-green-500" : pct >= 70 ? "bg-blue-400" : "bg-orange-400";
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-sm w-24 shrink-0">{name}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="text-sm text-gray-500">{current}/{goal}</span>
    </div>
  );
}
