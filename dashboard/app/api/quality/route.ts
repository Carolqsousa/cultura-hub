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

// Full stage regex — longer patterns MUST come before shorter ones:
//   PSTA before STA, PTEE before TEE, IE_FRA before nothing
// TTM → TEA (Tea Time), IE_FRA → FRA (Francês)
const STAGE_REGEX = `r'(?i)(ADV|BGN|ELE|INT|MST|PRI|PTEE|TEA|TEE|UPP|VAN|JUN|PSTA|STA|NUR|YNG|TTM|IE_FRA)'`;

const STAGE_NORMALIZE = `
  CASE UPPER(REGEXP_EXTRACT(class_name, ${STAGE_REGEX}))
    WHEN 'TTM'    THEN 'TEA'
    WHEN 'IE_FRA' THEN 'FRA'
    ELSE UPPER(REGEXP_EXTRACT(class_name, ${STAGE_REGEX}))
  END
`;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const branch    = searchParams.get("branch")   || "all";
  const startDate = searchParams.get("start")    || "2026-02-01";
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
    // quant_atual  = current active students per stage (from students snapshot)
    // real_churn   = rescissions from cancellations_xls (full semester)
    // quant_anterior = quant_atual + real_churn (reconstructed semester start)
    // retention_pct  = quant_atual / quant_anterior × 100
    // This covers all rescissions including those before the pipeline started.
    const retentionSQL = `
      WITH
        snap_end AS (
          SELECT MAX(date) AS d
          FROM \`${P}.${D}.students\`
          WHERE date <= '${e}'
        ),
        latest_att AS (
          SELECT student_id, branch,
            CASE UPPER(REGEXP_EXTRACT(MAX(class_name), ${STAGE_REGEX}))
              WHEN 'TTM'    THEN 'TEA'
              WHEN 'IE_FRA' THEN 'FRA'
              ELSE UPPER(REGEXP_EXTRACT(MAX(class_name), ${STAGE_REGEX}))
            END AS stage
          FROM \`${P}.${D}.attendance\`
          WHERE date = (
            SELECT MAX(date) FROM \`${P}.${D}.attendance\`
            WHERE date <= '${e}'
          )
          GROUP BY student_id, branch
        ),
        current_students AS (
          SELECT s.student_id, s.branch,
            COALESCE(a.stage, '?') AS stage
          FROM \`${P}.${D}.students\` s
          LEFT JOIN latest_att a
            ON a.student_id = s.student_id AND a.branch = s.branch
          WHERE s.date = (SELECT d FROM snap_end)
          ${bfStudents}
        ),
        churn_by_stage AS (
          SELECT
            CASE UPPER(REGEXP_EXTRACT(class_name, ${STAGE_REGEX}))
              WHEN 'TTM'    THEN 'TEA'
              WHEN 'IE_FRA' THEN 'FRA'
              ELSE UPPER(REGEXP_EXTRACT(class_name, ${STAGE_REGEX}))
            END AS stage,
            COUNT(*) AS real_churn
          FROM \`${P}.${D}.cancellations_xls\`
          WHERE semester = '${sem}'
            AND is_real_churn = true
            AND event_date BETWEEN '${s}' AND '${e}'
            ${bfXls}
          GROUP BY stage
        )
      SELECT
        cs.stage,
        COUNT(DISTINCT cs.student_id)                    AS quant_atual,
        COUNT(DISTINCT cs.student_id)
          + COALESCE(MAX(ch.real_churn), 0)              AS quant_anterior,
        COALESCE(MAX(ch.real_churn), 0)                  AS real_churn,
        ROUND(SAFE_DIVIDE(
          COUNT(DISTINCT cs.student_id),
          COUNT(DISTINCT cs.student_id) + COALESCE(MAX(ch.real_churn), 0)
        ) * 100, 1) AS retention_pct,
        CAST(FORMAT_DATE('%Y-%m-%d', (SELECT d FROM snap_end)) AS STRING) AS snap_start_date,
        CAST(FORMAT_DATE('%Y-%m-%d', (SELECT d FROM snap_end)) AS STRING) AS snap_end_date
      FROM current_students cs
      LEFT JOIN churn_by_stage ch USING (stage)
      WHERE cs.stage != '?'
      GROUP BY cs.stage
      ORDER BY cs.stage
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
            AND event_date BETWEEN '${s}' AND '${e}'
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
          WHERE semester = '${sem}'
            AND event_date BETWEEN '${s}' AND '${e}'
            ${bfXls}
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
      WHERE semester = '${sem}'
        AND event_date BETWEEN '${s}' AND '${e}'
        ${bfXls}
      ORDER BY event_date DESC
    `;

    // ── 5. REASONS BREAKDOWN ──────────────────────────────────────────────
    const reasonsSQL = `
      SELECT
        reason,
        COUNT(*)               AS count,
        COUNTIF(is_real_churn) AS real_churn
      FROM \`${P}.${D}.cancellations_xls\`
      WHERE semester = '${sem}'
        AND event_date BETWEEN '${s}' AND '${e}'
        ${bfXls}
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

    const snapDates = {
      start: startDate,
      end:   endDate,
    };

    return NextResponse.json({
      snapDates, byStage, byClass, byTeacher, cancels, reasons,
    });

  } catch (err: any) {
    console.error("[/api/quality]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
