import { getUser } from "@/lib/auth";
import { getStudentSummary, getAtRiskStudents } from "@/lib/queries/students";
import { redirect } from "next/navigation";

export default async function StudentsPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const [summary, atRisk] = await Promise.all([
    getStudentSummary(user),
    getAtRiskStudents(user),
  ]);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">Students</h1>
      <pre className="text-xs">{JSON.stringify({ summary, atRisk }, null, 2)}</pre>
    </main>
  );
}
