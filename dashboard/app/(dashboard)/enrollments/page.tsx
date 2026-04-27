import { getUser } from "@/lib/auth";
import { getEnrollmentGoals, getCancellationTrend, getLeadPipeline } from "@/lib/queries/enrollments";
import { redirect } from "next/navigation";

export default async function EnrollmentsPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const [goals, cancellations, leads] = await Promise.all([
    getEnrollmentGoals(user),
    getCancellationTrend(user),
    getLeadPipeline(user),
  ]);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">Enrollments</h1>
      <pre className="text-xs">{JSON.stringify({ goals, cancellations, leads }, null, 2)}</pre>
    </main>
  );
}
