import { query, DATASET } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const branch     = searchParams.get("branch") || "all";
  const startDate  = searchParams.get("start_date") || "2026-01-01";
  const endDate    = searchParams.get("end_date") || "2026-12-31";

  const branchFilter = branch !== "all" ? `AND f.branch = '${branch}'` : "";

  const rows = await query(`
    WITH latest_financials AS (
      SELECT
        student_id,
        branch,
        COUNT(*)                              as open_installments,
        ROUND(SUM(value), 2)                  as total_value,
        FORMAT_DATE('%Y-%m-%d', MIN(maturity)) as oldest_maturity,
        FORMAT_DATE('%Y-%m-%d', MAX(maturity)) as newest_maturity
      FROM \`${DATASET}.financials\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.financials\`)
        AND maturity BETWEEN '${startDate}' AND '${endDate}'
      GROUP BY student_id, branch
    ),
    latest_students AS (
      SELECT student_id, name
      FROM \`${DATASET}.students\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.students\`)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY date DESC) = 1
    )
    SELECT
      f.student_id,
      f.branch,
      s.name,
      f.open_installments,
      f.total_value,
      f.oldest_maturity,
      f.newest_maturity
    FROM latest_financials f
    LEFT JOIN latest_students s ON f.student_id = s.student_id
    WHERE 1=1 ${branchFilter}
    ORDER BY f.total_value DESC
  `);

  return Response.json({ students: rows });
}
