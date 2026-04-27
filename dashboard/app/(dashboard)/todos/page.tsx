import { getUser } from "@/lib/auth";
import { query, DATASET } from "@/lib/bigquery";
import { branchFilter } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function TodosPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const todos = await query(`
    SELECT week, branch, manager, task, due_date, done
    FROM \`${DATASET}.todos\`
    WHERE week = DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
      AND ${branchFilter(user)}
    ORDER BY branch, due_date
  `);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">To-Do — This Week</h1>
      <pre className="text-xs">{JSON.stringify(todos, null, 2)}</pre>
    </main>
  );
}
