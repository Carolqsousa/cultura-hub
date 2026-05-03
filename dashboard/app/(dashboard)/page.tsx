import { query, DATASET } from "@/lib/bigquery";

interface DiaryRow {
  branch: string;
  total_lessons: number;
  completed: number;
  pending: number;
  pct_complete: number;
}

interface StudentRow {
  branch: string;
  total: number;
}

async function getDiaryByBranch(): Promise<DiaryRow[]> {
  return query<DiaryRow>(`
    SELECT
      branch,
      SUM(total_lessons) as total_lessons,
      SUM(completed) as completed,
      SUM(pending) as pending,
      ROUND(SUM(completed) / NULLIF(SUM(total_lessons), 0) * 100, 1) as pct_complete
    FROM \`${DATASET}.diary_checks\`
    WHERE date = (SELECT MAX(date) FROM \`${DATASET}.diary_checks\`)
    GROUP BY branch
    ORDER BY branch
  `);
}

async function getStudentsByBranch(): Promise<StudentRow[]> {
  return query<StudentRow>(`
    SELECT branch, COUNT(*) as total
    FROM \`${DATASET}.students\`
    WHERE date = (SELECT MAX(date) FROM \`${DATASET}.students\`)
    AND status = 'Ativo'
    GROUP BY branch
    ORDER BY branch
  `);
}

export default async function OverviewPage() {
  const [diary, students] = await Promise.all([
    getDiaryByBranch(),
    getStudentsByBranch(),
  ]);

  const totalStudents = students.reduce((s, r) => s + Number(r.total), 0);
  const totalPending  = diary.reduce((s, r) => s + Number(r.pending), 0);
  const totalLessons  = diary.reduce((s, r) => s + Number(r.total_lessons), 0);
  const totalCompleted = diary.reduce((s, r) => s + Number(r.completed), 0);
  const overallPct    = totalLessons > 0 ? Math.round(totalCompleted / totalLessons * 100) : 0;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Cultura Hub</h1>
      <p className="text-sm text-gray-500 mb-8">Visão geral — todas as unidades</p>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <MetricCard label="Alunos ativos" value={totalStudents.toLocaleString("pt-BR")} color="text-green-600" />
        <MetricCard label="Diários pendentes" value={String(totalPending)} color={totalPending > 0 ? "text-orange-500" : "text-green-600"} />
        <MetricCard label="% diário OK" value={`${overallPct}%`} color={overallPct >= 90 ? "text-green-600" : "text-orange-500"} />
        <MetricCard label="Turmas monitoradas" value={String(diary.reduce((s, r) => s, 0))} color="text-blue-600" />
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card title="Diário de aula por unidade">
          {diary.length === 0 && <p className="text-sm text-gray-400">Sem dados disponíveis</p>}
          {diary.map(r => (
            <BranchRow
              key={r.branch}
              name={r.branch}
              pct={Number(r.pct_complete)}
              pending={Number(r.pending)}
            />
          ))}
        </Card>

        <Card title="Alunos ativos por unidade">
          {students.length === 0 && <p className="text-sm text-gray-400">Sem dados disponíveis</p>}
          {students.map(r => (
            <div key={r.branch} className="flex items-center justify-between mb-3">
              <span className="text-sm">{r.branch}</span>
              <span className="text-sm font-medium text-green-600">{Number(r.total).toLocaleString("pt-BR")}</span>
            </div>
          ))}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-6">
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
    <div className="bg-white rounded-xl border p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">{title}</h2>
      {children}
    </div>
  );
}

function BranchRow({ name, pct, pending }: { name: string; pct: number; pending: number }) {
  const color = pct === 100 ? "bg-green-500" : pct >= 80 ? "bg-orange-400" : "bg-red-400";
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
  const pct = Math.round(current / goal * 100);
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
