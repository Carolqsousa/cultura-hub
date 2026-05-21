"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { supabase } from "@/lib/supabase";

interface FinancialStudent {
  student_id: string;
  branch: string;
  name: string;
  open_installments: number;
  total_value: number;
  oldest_maturity: string;
  newest_maturity: string;
  // from contacts (future)
  responsible_name?: string;
  responsible_phone?: string;
  responsible_email?: string;
}

interface TrackingRecord {
  student_id: string;
  branch: string;
  status: string;
  notes: string;
  updated_at: string;
}

const STATUS_OPTIONS = [
  "Sem contato",
  "Em negociação",
  "Aguardando recibo",
  "Recibo recebido",
  "Aguardando baixa",
  "Pago",
];

const STATUS_COLORS: Record<string, string> = {
  "Sem contato":      "bg-gray-100 text-gray-600",
  "Em negociação":    "bg-blue-100 text-blue-700",
  "Aguardando recibo":"bg-yellow-100 text-yellow-700",
  "Recibo recebido":  "bg-purple-100 text-purple-700",
  "Aguardando baixa": "bg-orange-100 text-orange-700",
  "Pago":             "bg-green-100 text-green-700",
};


// ── Interest calculation ──────────────────────────────────────────────────────
function calcInterest(value: number, oldestMaturity: string): { multa: number; juros: number; total: number } {
  if (!oldestMaturity) return { multa: 0, juros: 0, total: value };
  const today     = new Date();
  const maturity  = new Date(oldestMaturity);
  const daysLate  = Math.max(0, Math.floor((today.getTime() - maturity.getTime()) / (1000 * 60 * 60 * 24)));
  const multa     = daysLate > 0 ? value * 0.02 : 0;
  const juros     = daysLate > 0 ? value * (1 / 100) * (daysLate / 30) : 0;
  return {
    multa:  Math.round(multa  * 100) / 100,
    juros:  Math.round(juros  * 100) / 100,
    total:  Math.round((value + multa + juros) * 100) / 100,
  };
}

type SortKey = "name" | "branch" | "open_installments" | "total_value" | "oldest_maturity" | "status" | "total_com_juros";

export default function FinancialPage() {
  const [students, setStudents]   = useState<FinancialStudent[]>([]);
  const [tracking, setTracking]   = useState<Record<string, TrackingRecord>>({});
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState<string | null>(null);

  // Filters
  const [branch, setBranch]       = useState("all");
  const [startDate, setStartDate] = useState("2026-01-01");
  const [endDate, setEndDate]     = useState("2026-12-31");
  const [search, setSearch]       = useState("");
  const [sortKey, setSortKey]     = useState<SortKey>("total_value");
  const [sortAsc, setSortAsc]     = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");

  // Notes debounce
  const notesTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Load BigQuery data
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (branch !== "all") params.set("branch", branch);
    fetch(`/api/financial?${params}`)
      .then(r => r.json())
      .then(d => { setStudents(d.students || []); setLoading(false); });
  }, [branch, startDate, endDate]);

  // Load Supabase tracking
  useEffect(() => {
    supabase
      .from("financial_tracking")
      .select("*")
      .then(({ data }) => {
        if (!data) return;
        const map: Record<string, TrackingRecord> = {};
        data.forEach(r => { map[`${r.student_id}-${r.branch}`] = r; });
        setTracking(map);
      });
  }, []);

  const branches = useMemo(() =>
    ["all", ...Array.from(new Set(students.map(s => s.branch))).sort()],
    [students]
  );

  // Summary KPIs
  const totalValue       = useMemo(() => students.reduce((s, r) => s + Number(r.total_value), 0), [students]);
  const totalComJuros    = useMemo(() => students.reduce((s, r) => {
    const { total } = calcInterest(Number(r.total_value), r.oldest_maturity);
    return s + total;
  }, 0), [students]);
  const totalInstallments = useMemo(() => students.reduce((s, r) => s + Number(r.open_installments), 0), [students]);
  const paidCount        = useMemo(() => Object.values(tracking).filter(t => t.status === "Pago").length, [tracking]);

  // Filtered + sorted
  const filtered = useMemo(() => {
    let rows = students.map(s => ({
      ...s,
      tracking: tracking[`${s.student_id}-${s.branch}`] || { status: "Sem contato", notes: "" },
    }));

    if (statusFilter !== "all") rows = rows.filter(s => s.tracking.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(s => s.name?.toLowerCase().includes(q) || s.branch?.toLowerCase().includes(q));
    }

    return [...rows].sort((a, b) => {
      let av: any = sortKey === "status" ? a.tracking.status : (a as any)[sortKey] ?? "";
      let bv: any = sortKey === "status" ? b.tracking.status : (b as any)[sortKey] ?? "";
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
  }, [students, tracking, statusFilter, search, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  }

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    return (
      <th onClick={() => toggleSort(k)}
        className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-gray-800">
        {label}{sortKey === k ? (sortAsc ? " ↑" : " ↓") : ""}
      </th>
    );
  }

  async function updateStatus(studentId: string, branch: string, status: string) {
    const key = `${studentId}-${branch}`;
    setSaving(key);
    const existing = tracking[key];
    const record = {
      student_id: studentId,
      branch,
      status,
      notes: existing?.notes || "",
      updated_at: new Date().toISOString(),
    };

    await supabase.from("financial_tracking").upsert(record, {
      onConflict: "student_id,branch",
    });

    setTracking(prev => ({ ...prev, [key]: { ...prev[key], ...record } }));
    setSaving(null);
  }

  function updateNotes(studentId: string, branch: string, notes: string) {
    const key = `${studentId}-${branch}`;
    setTracking(prev => ({ ...prev, [key]: { ...prev[key], student_id: studentId, branch, status: prev[key]?.status || "Sem contato", notes, updated_at: new Date().toISOString() } }));

    // Debounce save
    clearTimeout(notesTimer.current[key]);
    notesTimer.current[key] = setTimeout(async () => {
      const existing = tracking[key];
      await supabase.from("financial_tracking").upsert({
        student_id: studentId,
        branch,
        status: existing?.status || "Sem contato",
        notes,
        updated_at: new Date().toISOString(),
      }, { onConflict: "student_id,branch" });
    }, 800);
  }

  function handlePrint() {
    window.print();
  }

  return (
    <main className="p-6 space-y-6">
      {/* Print styles */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body { font-size: 11px; }
          th, td { padding: 4px 8px !important; }
        }
        .print-only { display: none; }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Financeiro</h1>
          <p className="text-sm text-gray-500 mt-1">Parcelas em aberto</p>
        </div>
        <button
          onClick={handlePrint}
          className="no-print flex items-center gap-2 bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-gray-700 transition-colors"
        >
          📄 Gerar PDF
        </button>
      </div>

      {/* Print header */}
      <div className="print-only mb-4">
        <h2 className="text-lg font-bold">Relatório Financeiro — Cultura Inglesa</h2>
        <p>Período: {startDate} a {endDate} {branch !== "all" ? `| Unidade: ${branch}` : "| Todas as unidades"}</p>
        <p>Gerado em: {new Date().toLocaleString("pt-BR")}</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-3 gap-4 no-print">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Alunos em atraso</p>
          <p className="text-3xl font-bold text-red-600">{students.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Total em aberto</p>
          <p className="text-3xl font-bold text-red-600">
            R$ {totalValue.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Parcelas em aberto</p>
          <p className="text-3xl font-bold text-orange-500">{totalInstallments}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center no-print">
        <select value={branch} onChange={e => setBranch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          {branches.map(b => <option key={b} value={b}>{b === "all" ? "Todas as unidades" : b}</option>)}
        </select>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-medium">De:</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-medium">Até:</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">Todos os status</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <input type="text" placeholder="Buscar aluno..." value={search} onChange={e => setSearch(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-56 focus:outline-none focus:ring-2 focus:ring-blue-500" />

        <span className="text-sm text-gray-400 ml-auto">{filtered.length} aluno{filtered.length !== 1 ? "s" : ""}</span>
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
                  <SortTh label="Aluno"          k="name" />
                  <SortTh label="Unidade"         k="branch" />
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Responsável</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Telefone</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <SortTh label="Parcelas"        k="open_installments" />
                  <SortTh label="Total original"  k="total_value" />
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Multa (2%)</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Juros (1%)</th>
                  <SortTh label="Total c/ juros" k="total_com_juros" />
                  <SortTh label="Venc. mais antigo" k="oldest_maturity" />
                  <SortTh label="Status"          k="status" />
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide no-print">Observações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((s, idx) => {
                  const key     = `${s.student_id}-${s.branch}`;
                    const interest = calcInterest(Number(s.total_value), s.oldest_maturity);
                  const tracked = s.tracking;
                  return (
                    <tr key={`${key}-${idx}`} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-900 whitespace-nowrap">{s.name || "—"}</td>
                      <td className="px-3 py-2.5 text-gray-500">{s.branch}</td>
                      <td className="px-3 py-2.5 text-gray-500">{s.responsible_name || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2.5 text-gray-500">{s.responsible_phone || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2.5 text-gray-500">{s.responsible_email || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2.5 text-center text-orange-600 font-medium">{s.open_installments}</td>
                      <td className="px-3 py-2.5 font-medium text-gray-700">
                        R$ {Number(s.total_value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 text-orange-600">
                        R$ {interest.multa.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 text-orange-600">
                        R$ {interest.juros.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 font-bold text-red-600">
                        R$ {interest.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                        {s.oldest_maturity ? new Date(s.oldest_maturity).toLocaleDateString("pt-BR") : "—"}
                      </td>
                      <td className="px-3 py-2.5 no-print">
                        <select
                          value={tracked.status || "Sem contato"}
                          onChange={e => updateStatus(s.student_id, s.branch, e.target.value)}
                          disabled={saving === key}
                          className={`text-xs font-medium rounded-full px-2 py-1 border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400 ${STATUS_COLORS[tracked.status || "Sem contato"]}`}
                        >
                          {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2.5 print-only text-xs">{tracked.status || "Sem contato"}</td>
                      <td className="px-3 py-2.5 no-print">
                        <input
                          type="text"
                          placeholder="Adicionar nota..."
                          value={tracked.notes || ""}
                          onChange={e => updateNotes(s.student_id, s.branch, e.target.value)}
                          className="text-xs border border-gray-200 rounded px-2 py-1 w-48 focus:outline-none focus:ring-1 focus:ring-blue-400"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Print totals */}
              <tfoot className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                <tr>
                  <td colSpan={5} className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-center">{totalInstallments}</td>
                  <td className="px-3 py-2 text-red-600">
                    R$ {totalValue.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                  </td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
