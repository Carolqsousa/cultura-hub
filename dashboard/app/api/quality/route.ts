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

const BRANCH_TO_XLS: Record<string, string> = {
  "Boa Viagem": "BV",
  "Young":      "YG",
  "Setubal":    "SET",
  "Natal":      "CI Lagoa Nova",
};

const XLS_BRANCH_NORMALIZE = `
  CASE branch
    WHEN 'BV'            THEN 'Boa Viagem'
    WHEN 'YG'            THEN 'Young'
    WHEN 'SET'           THEN 'Setubal'
    WHEN 'CI Lagoa Nova' THEN 'Natal'
    ELSE branch
  END
`;

// Full stage regex — PSTA before STA, IE_FRA last (rare)
// TTM is normalised to TEA in the SELECT so both appear as one stage
const STAGE_REGEX = `r'(?i)(ADV|BGN|ELE|INT|MST|PRI|TEA|TEE|UPP|VAN|JUN|PSTA|STA|NUR|YNG|TTM|IE_FRA)'`;

// Normalise TTM → TEA so Tea Time classes merge with TEA stage
const STAGE_NORMALIZE = `
  CASE REGEXP_EXTRACT(class_name, ${STAGE_REGEX})
    WHEN 'TTM'    THEN 'TEA'
    WHEN 'ie_fra' THEN 'FRA'
    WHEN 'IE_FRA' THEN 'FRA'
    ELSE UPPER(REGEXP_EXTRACT(class_name, ${STAGE_REGEX}))
  END
`;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const branch    = searchParams.get("branch")   || "all";
  const startDate = searchParams.get("start")    || "2026-04-29";
  const endDate   = searchParams.get("end")      || new Date().toISOString().slice(0, 10);
  const semester  = searchParams.get("semester") || "2026.1";

  const P = PROJECT;
  const D = DATASET;
  const s = esc(startDate);
  const e = esc(endDate);
  const sem = esc(semester);

  const bfStudents = branch !== "all" ? `AND s.branch = '${esc(branch)}'`  : "";
  const bfLg       = branch !== "all" ? `AND lg.branch = '${esc(branch)}'` : "";
  const bfTc       = branch !== "all" ? `AND tc.branch = '${esc(branch)}'` : "";
  const xlsBranch  = BRANCH_TO_XLS[branch] || branch;
  const bfXls      = branch !== "all" ? `AND branch = '${esc(xlsBranch)}'` : "";

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
        latest_att_start AS (
          SELECT student_id, branch,
            ${STAGE_NORMALIZE.replace(/class_name/g, 'MAX(class_name)')} AS stage
          FROM \`${P}.${D}.attendance\`
          WHERE date = (
            SELECT MAX(date) FROM \`${P}.${D}.attendance\`
            WHERE date <= '${s}'
          )
          GROUP BY student_id, branch
        ),
        start_students AS (
          SELECT s.student_id, s.branch,
            COALESCE(a.stage, '?') AS stage
          FROM \`${P}.${D}.students\` s
          LEFT JOIN latest_att_start a
            ON a.student_id = s.student_id AND a.branch = s.branch
          WHERE s.date = (SELECT d FROM snap_start)
          ${bfStudents}
        ),
        end_students AS (
          SELECT s.student_id, s.branch
          FROM \`${P}.${D}.students\` s
          WHERE s.date = (SELECT d FROM snap_end)
          ${bfStudents}
        )
      SELECT
        st.stage,
        COUNT(DISTINCT st.student_id) AS quant_anterior,
        COUNT(DISTINCT CASE WHEN en.student_id IS NOT NULL THEN st.student_id END) AS quant_atual,
        ROUND(SAFE_DIVIDE(
          COUNT(DISTINCT CASE WHEN en.student_id IS NOT NULL THEN st.student_id END),
          COUNT(DISTINCT st.student_id)
        ) * 100, 1) AS retention_pct,
        CAST(FORMAT_DATE('%Y-%m-%d', (SELECT d FROM snap_start)) AS STRING) AS snap_start_date,
        CAST(FORMAT_DATE('%Y-%m-%d', (SELECT d FROM snap_end))   AS STRING) AS snap_end_date
      FROM start_students st
      LEFT JOIN end_students en USING (student_id, branch)
      WHERE st.stage != '?'
      GROUP BY st.stage
      ORDER BY st.stage
    `;

    // ── 2. BY CLASS ───────────────────────────────────────────────────────
    const byClassSQL = `
      WITH
        latest_grades AS (
          SELECT class_id, class_name, branch,
            ${STAGE_NORMALIZE} AS stage,
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
        class_teachers AS (
          SELECT class_id, branch, MAX(professor) AS teacher
          FROM \`${P}.${D}.diary_checks\`
          WHERE date <= '${e}'
          GROUP BY class_id, branch
        ),
        class_cancels AS (
          SELECT
            TRIM(SPLIT(class_name, ' - ')[OFFSET(0)]) AS class_code,
            ${XLS_BRANCH_NORMALIZE} AS branch,
            COUNT(*)               AS total_cancels,
            COUNTIF(is_real_churn) AS real_churn
          FROM \`${P}.${D}.cancellations_xls\`
          WHERE semester = '${sem}'
          GROUP BY class_code, branch
        )
      SELECT
        lg.class_name,
        lg.stage,
        lg.branch,
        COALESCE(ct.teacher, '')      AS teacher,
        COALESCE(cs.student_count, 0) AS student_count,
        cf.avg_freq,
        COALESCE(cc.total_cancels, 0) AS total_cancels,
        COALESCE(cc.real_churn, 0)    AS real_churn
      FROM latest_grades lg
      LEFT JOIN class_students cs ON cs.class_id = lg.class_id AND cs.branch = lg.branch
      LEFT JOIN class_freq      cf ON cf.class_id = lg.class_id AND cf.branch = lg.branch
      LEFT JOIN class_teachers  ct ON ct.class_id = lg.class_id AND ct.branch = lg.branch
      LEFT JOIN class_cancels   cc
        ON cc.class_code = TRIM(SPLIT(lg.class_name, ' - ')[OFFSET(0)])
        AND cc.branch = lg.branch
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
            ROUND(AVG(la.pct_presence), 1) AS avg_freq,
            COUNT(DISTINCT tc.class_id)    AS class_count,
            COUNT(DISTINCT gr.student_id)  AS student_count
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
        teacher_cancels AS (
          SELECT teacher,
            COUNT(*)               AS total_cancels,
            COUNTIF(is_real_churn) AS real_churn
          FROM \`${P}.${D}.cancellations_xls\`
          WHERE semester = '${sem}' ${bfXls}
          GROUP BY teacher
        )
      SELECT
        ts.teacher,
        ts.class_count,
        ts.student_count,
        ts.avg_freq,
        COALESCE(tc.total_cancels, 0) AS total_cancels,
        COALESCE(tc.real_churn, 0)    AS real_churn
      FROM teacher_stats ts
      LEFT JOIN teacher_cancels tc ON tc.teacher = ts.teacher
      ORDER BY ts.teacher
    `;

    // ── 4. CANCELLATIONS DETAIL ───────────────────────────────────────────
    const cancelsSQL = `
      SELECT
        FORMAT_DATE('%Y-%m-%d', event_date) AS event_date,
        branch, student_name, class_name, stage,
        teacher, reason, attendant,
        is_real_churn, is_turma_nao_formou
      FROM \`${P}.${D}.cancellations_xls\`
      WHERE semester = '${sem}' ${bfXls}
      ORDER BY event_date DESC
    `;

    // ── 5. REASONS BREAKDOWN ──────────────────────────────────────────────
    const reasonsSQL = `
      SELECT
        reason,
        COUNT(*)               AS count,
        COUNTIF(is_real_churn) AS real_churn
      FROM \`${P}.${D}.cancellations_xls\`
      WHERE semester = '${sem}' ${bfXls}
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
      snapDates, byStage, byClass, byTeacher, cancels, reasons,
    });

  } catch (err: any) {
    console.error("[/api/quality]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
