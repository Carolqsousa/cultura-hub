import { getUser } from "@/lib/auth";
import { getTeacherStats } from "@/lib/queries/teachers";
import { redirect } from "next/navigation";

export default async function TeachersPage({
  searchParams,
}: {
  searchParams: { teacher?: string };
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const stats = await getTeacherStats(user, searchParams.teacher);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">Teachers</h1>
      <pre className="text-xs">{JSON.stringify(stats, null, 2)}</pre>
    </main>
  );
}
