import { query, DATASET } from "@/lib/bigquery";

export async function GET() {
  const result = await query(`
    SELECT branch, SUM(pending) as total_pending
    FROM \`${DATASET}.diary_checks\`
    WHERE date = (SELECT MAX(date) FROM \`${DATASET}.diary_checks\`)
    GROUP BY branch
  `);
  return Response.json({ data: result, timestamp: new Date().toISOString() });
}
