// dashboard/app/api/history/route.ts
// Serves semester-over-semester comparison data from retention_history table.
// Dimensions: global (per branch), stage, teacher, class — on demand.

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
    console.error("[/api/history] BigQuery error:", e);
    throw e;
  }
}

function esc(v: string) { return v.replace(/'/g, "''"); }

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const branch    = searchParams.get("branch") || "all";
  const dimension = searchParams.get("dimension") || "global"; // global|stage|teacher|class
  const snapType  = searchParams.get("snap_type") || "end";    // start|mid|end

  const P = PROJECT;
  const D = DATASET;

  const bfBranch  = branch !== "all" ? `AND branch = '${esc(branch)}'` : "";
  const bfBranchG = branch !== "all" ? `AND rh.branch = '${esc(branch)}'` : "";

  try {
    // ── 1. AVAILABLE SEMESTERS ────────────────────────────────────────────
    // Which semesters have data in retention_history
    const semestersSQL = `
      SELECT DISTINCT semester, snapshot_type,
        MIN(snapshot_date) AS snapshot_date,
        MIN(is_estimated)  AS is_estimated
      FROM \`${P}.${D}.retention_history\`
      WHERE snapshot_type != 'test'
      GROUP BY semester, snapshot_type
      ORDER BY semester, snapshot_type
    `;

    // ── 2. GLOBAL — semester over semester per branch ─────────────────────
    const globalSQL = `
      SELECT
        rh.semester,
        rh.snapshot_date,
        rh.snapshot_type,
        rh.is_estimated,
        rh.branch,
        rh.student_count,
        rh.real_churn,
        rh.total_churn,
        rh.retention_pct,
        rh.avg_freq,
        -- New enrollments approximation: current - (prev_end - churn)
        -- Only available when we have a start snapshot for comparison
        NULL AS new_enrollments,
        -- Revenue from financials table (sum of all parcelas in semester period)
        COALESCE(f.total_revenue, 0)  AS total_revenue,
        COALESCE(f.total_paid, 0)     AS total_paid,
        COALESCE(f.total_overdue, 0)  AS total_overdue
      FROM \`${P}.${D}.retention_history\` rh
      LEFT JOIN (
        SELECT
          branch,
          -- Map semester to date range
          CASE
            WHEN EXTRACT(MONTH FROM maturity) BETWEEN 2 AND 6
              THEN CONCAT(CAST(EXTRACT(YEAR FROM maturity) AS STRING), '.1')
            ELSE CONCAT(CAST(EXTRACT(YEAR FROM maturity) AS STRING), '.2')
          END AS semester,
          ROUND(SUM(value), 2)                              AS total_revenue,
          ROUND(SUM(CASE WHEN status = 1 THEN value_paid ELSE 0 END), 2) AS total_paid,
          ROUND(SUM(CASE WHEN status = 0 THEN value ELSE 0 END), 2)      AS total_overdue
        FROM \`${P}.${D}.financials\`
        GROUP BY branch, semester
      ) f ON f.branch = rh.branch AND f.semester = rh.semester
      WHERE rh.dimension = 'global'
        AND rh.snapshot_type = '${esc(snapType)}'
        AND rh.snapshot_type != 'test'
        ${bfBranchG}
      ORDER BY rh.semester, rh.branch
    `;

    // ── 3. BY STAGE — semester over semester ─────────────────────────────
    const stageSQL = `
      SELECT
        semester, snapshot_date, snapshot_type, is_estimated,
        branch, stage,
        student_count, real_churn, retention_pct
      FROM \`${P}.${D}.retention_history\`
      WHERE dimension = 'stage'
        AND snapshot_type = '${esc(snapType)}'
        AND snapshot_type != 'test'
        AND stage IS NOT NULL AND stage != ''
        ${bfBranch}
      ORDER BY semester, stage
    `;

    // ── 4. BY TEACHER — semester over semester ────────────────────────────
    const teacherSQL = `
      SELECT
        semester, snapshot_date, snapshot_type, is_estimated,
        teacher, class_count, student_count,
        real_churn, retention_pct, avg_freq
      FROM \`${P}.${D}.retention_history\`
      WHERE dimension = 'teacher'
        AND snapshot_type = '${esc(snapType)}'
        AND snapshot_type != 'test'
        AND teacher IS NOT NULL AND teacher != ''
      ORDER BY semester, teacher
    `;

    // ── 5. BY CLASS — semester over semester ──────────────────────────────
    const classSQL = `
      SELECT
        semester, snapshot_date, snapshot_type, is_estimated,
        branch, class_name, stage, teacher,
        student_count, real_churn, retention_pct, avg_freq
      FROM \`${P}.${D}.retention_history\`
      WHERE dimension = 'class'
        AND snapshot_type = '${esc(snapType)}'
        AND snapshot_type != 'test'
        ${bfBranch}
      ORDER BY semester, class_name
    `;

    // Run queries based on requested dimension
    const queries: Promise<any[]>[] = [bqQuery(semestersSQL), bqQuery(globalSQL)];
    if (dimension === "stage")   queries.push(bqQuery(stageSQL));
    if (dimension === "teacher") queries.push(bqQuery(teacherSQL));
    if (dimension === "class")   queries.push(bqQuery(classSQL));

    const [semesters, global, detail] = await Promise.all(queries);

    return NextResponse.json({
      semesters,
      global,
      detail: detail || [],
      dimension,
      snap_type: snapType,
    });

  } catch (err: any) {
    console.error("[/api/history]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
