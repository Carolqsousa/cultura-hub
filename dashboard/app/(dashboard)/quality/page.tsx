import { getUser } from "@/lib/auth";
import { query, DATASET } from "@/lib/bigquery";
import { branchFilter } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function QualityPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const nps = await query(`
    SELECT branch, teacher, AVG(score) AS avg_score, SUM(responses) AS total_responses
    FROM \`${DATASET}.nps\`
    WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
      AND ${branchFilter(user)}
    GROUP BY branch, teacher
    ORDER BY branch, avg_score DESC
  `);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">Quality & NPS</h1>
      <pre className="text-xs">{JSON.stringify(nps, null, 2)}</pre>
    </main>
  );
}
