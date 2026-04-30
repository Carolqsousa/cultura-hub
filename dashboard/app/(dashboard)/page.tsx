export default function OverviewPage() {
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Cultura Hub</h1>
      <p className="text-sm text-gray-500 mb-8">Visão geral — todas as unidades</p>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <MetricCard label="Alunos ativos" value="1.243" color="text-green-600" />
        <MetricCard label="Inadimplentes" value="87" color="text-red-500" />
        <MetricCard label="Diários pendentes" value="23" color="text-orange-500" />
        <MetricCard label="NPS médio" value="74" color="text-blue-600" />
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        <Card title="Diário de aula por unidade">
          <BranchRow name="Boa Viagem" pct={93} pending={4} />
          <BranchRow name="Young" pct={100} pending={0} />
          <BranchRow name="Setubal" pct={78} pending={11} />
          <BranchRow name="Natal" pct={85} pending={7} />
        </Card>

        <Card title="Matrículas vs meta — 2026.1">
          <GoalRow name="Boa Viagem" current={48} goal={60} />
          <GoalRow name="Young" current={31} goal={40} />
          <GoalRow name="Setubal" current={22} goal={30} />
          <GoalRow name="Natal" current={19} goal={25} />
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Card title="Alunos em risco">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="pb-2">Aluno</th>
                <th className="pb-2">Unidade</th>
                <th className="pb-2">Faltas</th>
                <th className="pb-2">Financeiro</th>
                <th className="pb-2">Nota</th>
              </tr>
            </thead>
            <tbody>
              <AtRiskRow name="João Silva" branch="Boa Viagem" absences={4} financial="Atrasado" grade="Abaixo" />
              <AtRiskRow name="Maria Santos" branch="Young" absences={3} financial="Em dia" grade="Abaixo" />
              <AtRiskRow name="Pedro Lima" branch="Setubal" absences={5} financial="Atrasado" grade="OK" />
              <AtRiskRow name="Ana Costa" branch="Natal" absences={2} financial="Atrasado" grade="Abaixo" />
            </tbody>
          </table>
        </Card>

        <Card title="Professores — diário desta semana">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b">
                <th className="pb-2">Professor</th>
                <th className="pb-2">Turmas</th>
                <th className="pb-2">Pendentes</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              <TeacherRow name="Pablo Gomes" classes={3} pending={17} />
              <TeacherRow name="Flavio Franca" classes={6} pending={2} />
              <TeacherRow name="Edna Alves" classes={3} pending={3} />
              <TeacherRow name="Mauro Vilela" classes={4} pending={1} />
              <TeacherRow name="Ivanilson Melo" classes={5} pending={0} />
            </tbody>
          </table>
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
      {pending > 0 && <span className="text-xs text-red-500 w-16">{pending} pend.</span>}
      {pending === 0 && <span className="text-xs text-green-500 w-16">Em dia</span>}
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

function AtRiskRow({ name, branch, absences, financial, grade }: {
  name: string; branch: string; absences: number; financial: string; grade: string;
}) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 font-medium">{name}</td>
      <td className="py-2 text-gray-500">{branch}</td>
      <td className="py-2 text-orange-500">{absences}</td>
      <td className={`py-2 ${financial === "Atrasado" ? "text-red-500" : "text-green-600"}`}>{financial}</td>
      <td className={`py-2 ${grade === "Abaixo" ? "text-red-500" : "text-green-600"}`}>{grade}</td>
    </tr>
  );
}

function TeacherRow({ name, classes, pending }: { name: string; classes: number; pending: number }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 font-medium">{name}</td>
      <td className="py-2 text-gray-500">{classes}</td>
      <td className={`py-2 ${pending > 0 ? "text-red-500 font-medium" : "text-gray-400"}`}>{pending}</td>
      <td className="py-2">
        {pending === 0
          ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Em dia</span>
          : <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Pendente</span>
        }
      </td>
    </tr>
  );
}
