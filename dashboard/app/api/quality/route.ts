// dashboard/app/api/quality/route.ts

import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROJECT = process.env.GCP_PROJECT_ID || "cultura-hub";
const DATASET = "cultura_hub";

function getClient() {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credsJson) {
    return new BigQuery({ projectId: PROJECT, credentials: JSON.parse(credsJson) });
  }
  return new BigQuery({ projectId: PROJECT });
}

async function bqQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  try {
    const [rows] = await getClient().query({ query: sql, location: "southamerica-east1" });
    return rows as T[];
  } catch (e) {
    console.error("[/api/quality] BigQuery error:", e);
    throw e;
  }
}

function esc(val: string) {
  return val.replace(/'/g, "''");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const branch    = searchParams.get("branch")   || "all";
  const startDate = searchParams.get("start")    || "2026-02-01";
  const endDate   = searchParams.get("end")      || new Date().toISOString().slice(0, 10);
  const semester  = searchParams.get("semester") || "2026.1";

  const P = PROJECT;
  const D = DATASET;
  const b = esc(branch);
  const s = esc(startDate);
  const e = esc(endDate);
  const sem = esc(semester);

  // Branch filters with explicit table aliases — avoids ambiguous column errors
  const bfStudents  = branch !== "all" ? `AND s.branch = '${b}'`  : "";
  const bfLg        = branch !== "all" ? `AND lg.branch = '${b}'` : "";
  const bfTc        = branch !== "all" ? `AND tc.branch = '${b}'` : "";
  const bfPlain     = branch !== "all" ? `AND branch = '${b}'`    : "";

  try {
    // ── 1. RETENTION BY STAGE ─────────────────────────────────────────────
    const retentionSQL = `
      WITH
        snap_start AS (
          SELECT MAX(date) AS d
          FROM \`${P}.${D}.students\`
          WHERE date <= '${s}'
        ),
        snap_end AS (
          SELECT MAX(date) AS d
          FROM \`${P}.${D}.students\`
          WHERE date <= '${e}'
        ),
        start_students AS (
          SELECT s.student_id, s.branch,
            REGEXP_EXTRACT(COALESCE(g.class_name, ''),
              r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN)') AS stage
          FROM \`${P}.${D}.students\` s
          LEFT JOIN (
            SELECT student_id, branch, MAX(class_name) AS class_name
            FROM \`${P}.${D}.grades\`
            WHERE date = (SELECT d FROM snap_start)
            GROUP BY student_id, branch
          ) g USING (student_id, branch)
          WHERE s.date = (SELECT d FROM snap_start)
          ${bfStudents}
        ),
        end_students AS (
          SELECT s.student_id, s.branch,
            REGEXP_EXTRACT(COALESCE(g.class_name, ''),
              r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN)') AS stage
          FROM \`${P}.${D}.students\` s
          LEFT JOIN (
            SELECT student_id, branch, MAX(class_name) AS class_name
            FROM \`${P}.${D}.grades\`
            WHERE date = (SELECT d FROM snap_end)
            GROUP BY student_id, branch
          ) g USING (student_id, branch)
          WHERE s.date = (SELECT d FROM snap_end)
          ${bfStudents}
        )
      SELECT
        COALESCE(en.stage, st.stage, '?') AS stage,
        COUNT(DISTINCT st.student_id)     AS quant_anterior,
        COUNT(DISTINCT en.student_id)     AS quant_atual,
        ROUND(SAFE_DIVIDE(
          COUNT(DISTINCT en.student_id),
          COUNT(DISTINCT st.student_id)
        ) * 100, 1) AS retention_pct,
        CAST(FORMAT_DATE('%Y-%m-%d', (SELECT d FROM snap_start)) AS STRING) AS snap_start_date,
        CAST(FORMAT_DATE('%Y-%m-%d', (SELECT d FROM snap_end))   AS STRING) AS snap_end_date
      FROM start_students st
      FULL OUTER JOIN end_students en USING (student_id, branch)
      WHERE COALESCE(en.stage, st.stage, '?') != '?'
      GROUP BY stage
      ORDER BY stage
    `;

    // ── 2. BY CLASS ───────────────────────────────────────────────────────
    const byClassSQL = `
      WITH
        latest_grades AS (
          SELECT class_id, class_name, branch,
            REGEXP_EXTRACT(class_name,
              r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN)') AS stage,
            MAX(date) AS grade_date
          FROM \`${P}.${D}.grades\`
          WHERE date <= '${e}'
          GROUP BY class_id, class_name, branch, stage
        ),
        class_students AS (
          SELECT gr.class_id, gr.branch,
            COUNT(DISTINCT gr.student_id) AS student_count
          FROM \`${P}.${D}.grades\` gr
          JOIN latest_grades lg
            ON gr.class_id = lg.class_id
            AND gr.branch  = lg.branch
            AND gr.date    = lg.grade_date
          GROUP BY gr.class_id, gr.branch
        ),
        class_freq AS (
          SELECT class_id, branch,
            ROUND(AVG(pct_presence), 1) AS avg_freq
          FROM \`${P}.${D}.attendance\`
          WHERE date = (
            SELECT MAX(date) FROM \`${P}.${D}.attendance\`
            WHERE date <= '${e}'
          )
          GROUP BY class_id, branch
        ),
        class_grades AS (
          SELECT gr.class_id, gr.branch,
            ROUND(AVG(gr.overall_average), 1) AS avg_grade,
            MAX(gr.grade_format)               AS grade_format
          FROM \`${P}.${D}.grades\` gr
          JOIN latest_grades lg
            ON gr.class_id = lg.class_id
            AND gr.branch  = lg.branch
            AND gr.date    = lg.grade_date
          WHERE gr.overall_average IS NOT NULL
          GROUP BY gr.class_id, gr.branch
        ),
        class_teachers AS (
          SELECT class_id, branch, MAX(professor) AS teacher
          FROM \`${P}.${D}.diary_checks\`
          WHERE date <= '${e}'
          GROUP BY class_id, branch
        ),
        class_cancels AS (
          SELECT class_name, branch,
            COUNT(*)              AS total_cancels,
            COUNTIF(is_real_churn) AS real_churn
          FROM \`${P}.${D}.cancellations_xls\`
          WHERE semester = '${sem}'
          GROUP BY class_name, branch
        )
      SELECT
        lg.class_name,
        lg.stage,
        lg.branch,
        COALESCE(ct.teacher, '')       AS teacher,
        COALESCE(cs.student_count, 0)  AS student_count,
        cf.avg_freq,
        cg.avg_grade,
        cg.grade_format,
        COALESCE(cc.total_cancels, 0)  AS total_cancels,
        COALESCE(cc.real_churn, 0)     AS real_churn
      FROM latest_grades lg
      LEFT JOIN class_students cs ON cs.class_id = lg.class_id AND cs.branch = lg.branch
      LEFT JOIN class_freq      cf ON cf.class_id = lg.class_id AND cf.branch = lg.branch
      LEFT JOIN class_grades    cg ON cg.class_id = lg.class_id AND cg.branch = lg.branch
      LEFT JOIN class_teachers  ct ON ct.class_id = lg.class_id AND ct.branch = lg.branch
      LEFT JOIN class_cancels   cc ON cc.class_name = lg.class_name AND cc.branch = lg.branch
      WHERE 1=1 ${bfLg}
      ORDER BY lg.class_name
    `;

    // ── 3. BY TEACHER ─────────────────────────────────────────────────────
    const byTeacherSQL = `
      WITH
        teacher_classes AS (
          SELECT professor AS teacher, class_id, branch
          FROM \`${P}.${D}.diary_checks\`
          WHERE date <= '${e}'
            AND professor IS NOT NULL
            AND professor != ''
          GROUP BY professor, class_id, branch
        ),
        latest_grades AS (
          SELECT class_id, branch, MAX(date) AS grade_date
          FROM \`${P}.${D}.grades\`
          WHERE date <= '${e}'
          GROUP BY class_id, branch
        ),
        latest_attendance AS (
          SELECT class_id, branch, AVG(pct_presence) AS pct_presence
          FROM \`${P}.${D}.attendance\`
          WHERE date = (
            SELECT MAX(date) FROM \`${P}.${D}.attendance\`
            WHERE date <= '${e}'
          )
          GROUP BY class_id, branch
        ),
        teacher_stats AS (
          SELECT
            tc.teacher,
            ROUND(AVG(la.pct_presence), 1)  AS avg_freq,
            COUNT(DISTINCT tc.class_id)     AS class_count,
            COUNT(DISTINCT gr.student_id)   AS student_count
          FROM teacher_classes tc
          LEFT JOIN latest_attendance la
            ON la.class_id = tc.class_id AND la.branch = tc.branch
          LEFT JOIN \`${P}.${D}.grades\` gr
            ON gr.class_id = tc.class_id AND gr.branch = tc.branch
          LEFT JOIN latest_grades lg
            ON lg.class_id = tc.class_id AND lg.branch = tc.branch
            AND gr.date = lg.grade_date
          WHERE 1=1 ${bfTc}
          GROUP BY tc.teacher
        ),
        teacher_grades AS (
          SELECT tc.teacher,
            ROUND(AVG(gr.overall_average), 1) AS avg_grade
          FROM teacher_classes tc
          JOIN \`${P}.${D}.grades\` gr
            ON gr.class_id = tc.class_id AND gr.branch = tc.branch
          JOIN latest_grades lg
            ON lg.class_id = tc.class_id AND lg.branch = tc.branch
            AND gr.date = lg.grade_date
          WHERE gr.overall_average IS NOT NULL
          GROUP BY tc.teacher
        ),
        teacher_cancels AS (
          SELECT teacher,
            COUNT(*)               AS total_cancels,
            COUNTIF(is_real_churn) AS real_churn
          FROM \`${P}.${D}.cancellations_xls\`
          WHERE semester = '${sem}' ${bfPlain}
          GROUP BY teacher
        )
      SELECT
        ts.teacher,
        ts.class_count,
        ts.student_count,
        ts.avg_freq,
        tg.avg_grade,
        COALESCE(tc.total_cancels, 0) AS total_cancels,
        COALESCE(tc.real_churn, 0)    AS real_churn
      FROM teacher_stats ts
      LEFT JOIN teacher_grades  tg ON tg.teacher = ts.teacher
      LEFT JOIN teacher_cancels tc ON tc.teacher = ts.teacher
      ORDER BY ts.teacher
    `;

    // ── 4. CANCELLATIONS DETAIL ───────────────────────────────────────────
    const cancelsSQL = `
      SELECT
        FORMAT_DATE('%Y-%m-%d', event_date) AS event_date,
        branch,
        student_name,
        class_name,
        stage,
        teacher,
        reason,
        attendant,
        is_real_churn,
        is_turma_nao_formou
      FROM \`${P}.${D}.cancellations_xls\`
      WHERE semester = '${sem}' ${bfPlain}
      ORDER BY event_date DESC
    `;

    // ── 5. REASONS BREAKDOWN ──────────────────────────────────────────────
    const reasonsSQL = `
      SELECT
        reason,
        COUNT(*)               AS count,
        COUNTIF(is_real_churn) AS real_churn
      FROM \`${P}.${D}.cancellations_xls\`
      WHERE semester = '${sem}' ${bfPlain}
      GROUP BY reason
      ORDER BY count DESC
    `;

    const [byStage, byClass, byTeacher, cancels, reasons] = await Promise.all([
      bqQuery(retentionSQL),
      bqQuery(byClassSQL),
      bqQuery(byTeacherSQL),
      bqQuery(cancelsSQL),
      bqQuery(reasonsSQL),
    ]);

    const snapDates = byStage[0]
      ? {
          start: String((byStage[0] as any).snap_start_date || startDate),
          end:   String((byStage[0] as any).snap_end_date   || endDate),
        }
      : { start: startDate, end: endDate };

    return NextResponse.json({
      snapDates,
      byStage,
      byClass,
      byTeacher,
      cancels,
      reasons,
    });

  } catch (err: any) {
    console.error("[/api/quality]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
