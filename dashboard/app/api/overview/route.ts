import { query, DATASET } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

export async function GET() {
  const [diary, teachers, financials] = await Promise.all([
    query(`
      SELECT branch,
        SUM(total_lessons) as total_lessons,
        SUM(completed) as completed,
        SUM(pending) as pending,
        ROUND(SUM(completed) / NULLIF(SUM(total_lessons), 0) * 100, 1) as pct_complete
      FROM \`${DATASET}.diary_checks\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.diary_checks\`)
      GROUP BY branch ORDER BY branch
    `),
    query(`
      SELECT professor, branch,
        COUNT(*) as classes,
        SUM(total_lessons) as total_lessons,
        SUM(completed) as completed,
        SUM(pending) as pending,
        ROUND(SUM(completed) / NULLIF(SUM(total_lessons), 0) * 100, 1) as pct_complete
      FROM \`${DATASET}.diary_checks\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.diary_checks\`)
      AND professor IS NOT NULL AND professor != ''
      GROUP BY professor, branch
      ORDER BY pending DESC, professor
    `),
    query(`
      SELECT branch,
        COUNT(DISTINCT student_id) as students_behind,
        COUNT(*) as total_parcels,
        ROUND(SUM(value), 2) as total_value_due
      FROM \`${DATASET}.financials\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.financials\`)
      GROUP BY branch ORDER BY total_value_due DESC
    `),
  ]);

  return Response.json({ diary, teachers, financials });
}
