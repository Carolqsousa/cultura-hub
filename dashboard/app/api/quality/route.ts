// dashboard/app/api/quality/route.ts
// Serves all data for the /quality page:
//   - Retention by stage (snapshot diff)
//   - Frequency + grades by class and teacher
//   - Cancellations with reasons (from cancellations_xls table)

import { NextRequest, NextResponse } from "next/server";
import { getBigQueryClient } from "@/lib/bigquery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const branch    = searchParams.get("branch")   || "all";
  const startDate = searchParams.get("start")    || "2026-02-01";
  const endDate   = searchParams.get("end")      || new Date().toISOString().slice(0, 10);
  const semester  = searchParams.get("semester") || "2026.1";

  const bq      = getBigQueryClient();
  const dataset = "cultura_hub";
  const project = process.env.GCP_PROJECT_ID || "cultura-hub";

  const branchFilter      = branch !== "all" ? `AND branch = @branch` : "";
  const branchFilterAlias = branch !== "all" ? `AND s.branch = @branch` : "";

  const params: Record<string, string> = { startDate, endDate, semester };
  if (branch !== "all") params.branch = branch;

  const run = (sql: string) =>
    bq.query({ query: sql, params, location: "southamerica-east1" });

  try {
    // 1. RETENTION BY STAGE
    const retentionSQL = `
      WITH
        snap_start AS (
          SELECT MAX(date) AS d
          FROM \`${project}.${dataset}.students\`
          WHERE date <= @startDate
        ),
        snap_end AS (
          SELECT MAX(date) AS d
          FROM \`${project}.${dataset}.students\`
          WHERE date <= @endDate
        ),
        start_students AS (
          SELECT s.student_id, s.branch,
            REGEXP_EXTRACT(COALESCE(g.class_name,''),
              r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN)') AS stage
          FROM \`${project}.${dataset}.students\` s
          LEFT JOIN (
            SELECT student_id, branch, MAX(class_name) AS class_name
            FROM \`${project}.${dataset}.grades\`
            WHERE date = (SELECT d FROM snap_start)
            GROUP BY student_id, branch
          ) g USING (student_id, branch)
          WHERE s.date = (SELECT d FROM snap_start)
          ${branchFilterAlias}
        ),
        end_students AS (
          SELECT s.student_id, s.branch,
            REGEXP_EXTRACT(COALESCE(g.class_name,''),
              r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN)') AS stage
          FROM \`${project}.${dataset}.students\` s
          LEFT JOIN (
            SELECT student_id, branch, MAX(class_name) AS class_name
            FROM \`${project}.${dataset}.grades\`
            WHERE date = (SELECT d FROM snap_end)
            GROUP BY student_id, branch
          ) g USING (student_id, branch)
          WHERE s.date = (SELECT d FROM snap_end)
          ${branchFilterAlias}
        )
      SELECT
        COALESCE(e.stage, s.stage, '?') AS stage,
        COUNT(DISTINCT s.student_id)    AS quant_anterior,
        COUNT(DISTINCT e.student_id)    AS quant_atual,
        ROUND(SAFE_DIVIDE(
          COUNT(DISTINCT e.student_id),
          COUNT(DISTINCT s.student_id)
        ) * 100, 1) AS retention_pct,
        (SELECT d FROM snap_start) AS snap_start_date,
        (SELECT d FROM snap_end)   AS snap_end_date
      FROM start_students s
      FULL OUTER JOIN end_students e USING (student_id, branch)
      WHERE COALESCE(e.stage, s.stage, '?') != '?'
      GROUP BY stage
      ORDER BY stage
    `;

    // 2. BY CLASS
    const byClassSQL = `
      WITH
        latest_grades AS (
          SELECT class_id, class_name, branch,
            REGEXP_EXTRACT(class_name,
              r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN)') AS stage,
            MAX(date) AS grade_date
          FROM \`${project}.${dataset}.grades\`
          WHERE date <= @endDate
          GROUP BY class_id, class_name, branch, stage
        ),
        class_students AS (
          SELECT g.class_id, g.branch, COUNT(DISTINCT gr.student_id) AS student_count
          FROM latest_grades g
          JOIN \`${project}.${dataset}.grades\` gr
            ON gr.class_id = g.class_id AND gr.branch = g.branch AND gr.date = g.grade_date
          GROUP BY g.class_id, g.branch
        ),
        class_freq AS (
          SELECT class_id, branch, ROUND(AVG(pct_presence), 1) AS avg_freq
          FROM \`${project}.${dataset}.attendance\`
          WHERE date = (
            SELECT MAX(date) FROM \`${project}.${dataset}.attendance\`
            WHERE date <= @endDate
          )
          GROUP BY class_id, branch
        ),
        class_grades AS (
          SELECT gr.class_id, gr.branch,
            ROUND(AVG(gr.overall_average), 1) AS avg_grade,
            MAX(gr.grade_format) AS grade_format
          FROM \`${project}.${dataset}.grades\` gr
          JOIN latest_grades lg
            ON gr.class_id = lg.class_id AND gr.branch = lg.branch AND gr.date = lg.grade_date
          WHERE gr.overall_average IS NOT NULL
          GROUP BY gr.class_id, gr.branch
        ),
        class_teachers AS (
          SELECT class_id, branch, MAX(professor) AS teacher
          FROM \`${project}.${dataset}.diary_checks\`
          WHERE date <= @endDate
          GROUP BY class_id, branch
        ),
        class_cancels AS (
          SELECT class_name, branch,
            COUNT(*) AS total_cancels,
            COUNTIF(is_real_churn) AS real_churn
          FROM \`${project}.${dataset}.cancellations_xls\`
          WHERE semester = @semester
          GROUP BY class_name, branch
        )
      SELECT
        lg.class_name, lg.stage, lg.branch,
        COALESCE(ct.teacher, '') AS teacher,
        COALESCE(cs.student_count, 0) AS student_count,
        cf.avg_freq, cg.avg_grade, cg.grade_format,
        COALESCE(cc.total_cancels, 0) AS total_cancels,
        COALESCE(cc.real_churn, 0)    AS real_churn
      FROM latest_grades lg
      LEFT JOIN class_students cs USING (class_id, branch)
      LEFT JOIN class_freq cf USING (class_id, branch)
      LEFT JOIN class_grades cg USING (class_id, branch)
      LEFT JOIN class_teachers ct USING (class_id, branch)
      LEFT JOIN class_cancels cc
        ON cc.class_name = lg.class_name AND cc.branch = lg.branch
      WHERE 1=1 ${branchFilter}
      ORDER BY lg.class_name
    `;

    // 3. BY TEACHER
    const byTeacherSQL = `
      WITH
        teacher_classes AS (
          SELECT professor AS teacher, class_id, branch
          FROM \`${project}.${dataset}.diary_checks\`
          WHERE date <= @endDate AND professor IS NOT NULL AND professor != ''
          GROUP BY professor, class_id, branch
        ),
        latest_grades AS (
          SELECT class_id, branch, MAX(date) AS grade_date
          FROM \`${project}.${dataset}.grades\`
          WHERE date <= @endDate
          GROUP BY class_id, branch
        ),
        teacher_freq AS (
          SELECT tc.teacher,
            ROUND(AVG(a.pct_presence), 1) AS avg_freq,
            COUNT(DISTINCT tc.class_id)   AS class_count,
            COUNT(DISTINCT gr.student_id) AS student_count
          FROM teacher_classes tc
          LEFT JOIN (
            SELECT class_id, branch, AVG(pct_presence) AS pct_presence
            FROM \`${project}.${dataset}.attendance\`
            WHERE date = (
              SELECT MAX(date) FROM \`${project}.${dataset}.attendance\`
              WHERE date <= @endDate
            )
            GROUP BY class_id, branch
          ) a USING (class_id, branch)
          LEFT JOIN \`${project}.${dataset}.grades\` gr
            ON gr.class_id = tc.class_id AND gr.branch = tc.branch
          JOIN latest_grades lg
            ON gr.class_id = lg.class_id AND gr.branch = lg.branch AND gr.date = lg.grade_date
          WHERE 1=1
          GROUP BY tc.teacher
        ),
        teacher_grades AS (
          SELECT tc.teacher, ROUND(AVG(gr.overall_average), 1) AS avg_grade
          FROM teacher_classes tc
          JOIN \`${project}.${dataset}.grades\` gr USING (class_id, branch)
          JOIN latest_grades lg USING (class_id, branch)
          WHERE gr.date = lg.grade_date AND gr.overall_average IS NOT NULL
          GROUP BY tc.teacher
        ),
        teacher_cancels AS (
          SELECT teacher,
            COUNT(*) AS total_cancels,
            COUNTIF(is_real_churn) AS real_churn
          FROM \`${project}.${dataset}.cancellations_xls\`
          WHERE semester = @semester ${branchFilter}
          GROUP BY teacher
        )
      SELECT
        tf.teacher, tf.class_count, tf.student_count,
        tf.avg_freq, tg.avg_grade,
        COALESCE(tc2.total_cancels, 0) AS total_cancels,
        COALESCE(tc2.real_churn, 0)    AS real_churn
      FROM teacher_freq tf
      LEFT JOIN teacher_grades tg USING (teacher)
      LEFT JOIN teacher_cancels tc2 USING (teacher)
      ORDER BY tf.teacher
    `;

    // 4. CANCELLATIONS DETAIL
    const cancelsSQL = `
      SELECT
        event_date, branch, student_name, class_name,
        stage, teacher, reason, attendant,
        is_real_churn, is_turma_nao_formou
      FROM \`${project}.${dataset}.cancellations_xls\`
      WHERE semester = @semester ${branchFilter}
      ORDER BY event_date DESC
    `;

    // 5. REASONS BREAKDOWN
    const reasonsSQL = `
      SELECT
        reason,
        COUNT(*) AS count,
        COUNTIF(is_real_churn) AS real_churn
      FROM \`${project}.${dataset}.cancellations_xls\`
      WHERE semester = @semester ${branchFilter}
      GROUP BY reason
      ORDER BY count DESC
    `;

    const [[retentionRows], [byClassRows], [byTeacherRows], [cancelsRows], [reasonsRows]] =
      await Promise.all([
        run(retentionSQL),
        run(byClassSQL),
        run(byTeacherSQL),
        run(cancelsSQL),
        run(reasonsSQL),
      ]);

    const snapDates = retentionRows[0]
      ? {
          start: String((retentionRows[0] as any).snap_start_date?.value || startDate),
          end:   String((retentionRows[0] as any).snap_end_date?.value   || endDate),
        }
      : { start: startDate, end: endDate };

    return NextResponse.json({
      snapDates,
      byStage:   retentionRows,
      byClass:   byClassRows,
      byTeacher: byTeacherRows,
      cancels:   cancelsRows,
      reasons:   reasonsRows,
    });

  } catch (err: any) {
    console.error("[/api/quality]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
