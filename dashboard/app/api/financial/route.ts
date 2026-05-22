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
        COUNT(*)                               as open_installments,
        ROUND(SUM(value), 2)                   as total_value,
        FORMAT_DATE('%Y-%m-%d', MIN(maturity)) as oldest_maturity,
        FORMAT_DATE('%Y-%m-%d', MAX(maturity)) as newest_maturity,
        ARRAY_AGG(STRUCT(
          parcel_number,
          FORMAT_DATE('%Y-%m-%d', maturity) as maturity,
          ROUND(value, 2) as value
        ) ORDER BY maturity) as installments
      FROM \`${DATASET}.financials\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.financials\`)
        AND maturity BETWEEN '${startDate}' AND '${endDate}'
      GROUP BY student_id, branch
    ),
    latest_contacts AS (
      SELECT student_name_normalized, responsible_name, phone
      FROM \`${DATASET}.contacts\`
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
      c.responsible_name,
      c.phone,
      f.open_installments,
      f.total_value,
      f.oldest_maturity,
      f.newest_maturity,
      f.installments
    FROM latest_financials f
    LEFT JOIN latest_students s ON f.student_id = s.student_id
    LEFT JOIN latest_contacts c ON UPPER(REGEXP_REPLACE(NORMALIZE(s.name, NFD), r'\\p{Mn}', '')) = c.student_name_normalized
    WHERE 1=1 ${branchFilter}
    ORDER BY f.total_value DESC
  `);

  return Response.json({ students: rows });
}
