import { query, DATASET } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const branch = searchParams.get("branch") || "all";

  const branchFilter = branch !== "all"
    ? `AND s.branch = '${branch}'`
    : "";

  const rows = await query(`
    WITH latest_students AS (
      SELECT student_id, name, branch, teacher
      FROM \`${DATASET}.students\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.students\`)
    ),
    latest_attendance AS (
      SELECT student_id, class_id, class_name, pct_presence, presences, absences, total_lessons
      FROM \`${DATASET}.attendance\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.attendance\`)
    ),
    latest_grades AS (
      SELECT student_id, class_id, class_name, overall_average, grade_format, provas_entered
      FROM \`${DATASET}.grades\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.grades\`)
    ),
    latest_financials AS (
      SELECT
        student_id,
        COUNT(*) as open_installments,
        ROUND(SUM(value), 2) as total_value
      FROM \`${DATASET}.financials\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.financials\`)
        AND EXTRACT(YEAR FROM maturity) = 2026
      GROUP BY student_id
    )
    SELECT
      s.student_id,
      s.name,
      s.branch,
      COALESCE(a.class_name, g.class_name) as class_name,
      s.teacher,
      a.pct_presence,
      a.presences,
      a.absences,
      a.total_lessons,
      g.overall_average,
      g.grade_format,
      g.provas_entered,
      COALESCE(f.open_installments, 0) as open_installments,
      COALESCE(f.total_value, 0.0) as total_value
    FROM latest_students s
    LEFT JOIN latest_attendance a ON s.student_id = a.student_id
    LEFT JOIN latest_grades g ON s.student_id = g.student_id
    LEFT JOIN latest_financials f ON s.student_id = f.student_id
    WHERE 1=1 ${branchFilter}
    ORDER BY s.branch, s.name
  `);

  return Response.json({ students: rows });
}
