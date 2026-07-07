// dashboard/app/api/renewal/route.ts
// Serves renewal status data from renewal_status and renewal_baseline tables.

import { NextRequest, NextResponse } from "next/server";
import { BigQuery } from "@google-cloud/bigquery";
import { serializeBQRows } from "@/lib/bq-serialize";

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
    console.error("[/api/renewal] BigQuery error:", e);
    throw e;
  }
}

function esc(v: string) { return v.replace(/'/g, "''"); }

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const branch   = searchParams.get("branch") || "all";
  const semester = searchParams.get("semester") || "2026.1";

  const P = PROJECT;
  const D = DATASET;
  const bfPlain = branch !== "all" ? `AND branch = '${esc(branch)}'` : "";

  try {
    // ── 1. SUMMARY by status ──────────────────────────────────────────────
    const summarySQL = `
      SELECT
        status,
        COUNT(*) AS students,
        COUNT(DISTINCT branch) AS branches
      FROM \`${P}.${D}.renewal_status\`
      WHERE ending_semester = '${esc(semester)}' ${bfPlain}
      GROUP BY status
      ORDER BY status
    `;

    // ── 2. SUMMARY by branch ──────────────────────────────────────────────
    const byBranchSQL = `
      SELECT
        branch,
        COUNTIF(status = 'Renovado')  AS renovado,
        COUNTIF(status = 'Pendente')  AS pendente,
        COUNTIF(status = 'Cancelado') AS cancelado,
        COUNT(*) AS total,
        ROUND(COUNTIF(status = 'Renovado') / COUNT(*) * 100, 1) AS renewal_pct
      FROM \`${P}.${D}.renewal_status\`
      WHERE ending_semester = '${esc(semester)}'
      GROUP BY branch
      ORDER BY branch
    `;

    // ── 3. DETAIL LIST — all students with status ──────────────────────────
    // NOTE: latest_check_date and baseline_date are DATE columns. The
    // BigQuery driver returns these as { value: "YYYY-MM-DD" } wrapper
    // objects, not plain strings — serializeBQRows() below unwraps them.
    const detailSQL = `
      SELECT
        rs.student_id,
        rs.name,
        rs.branch,
        rs.status,
        rs.next_class_id,
        rs.latest_check_date,
        rs.baseline_date
      FROM \`${P}.${D}.renewal_status\` rs
      WHERE rs.ending_semester = '${esc(semester)}' ${bfPlain}
      ORDER BY rs.status, rs.branch, rs.name
    `;

    // ── 4. META — last check date and baseline date ───────────────────────
    const metaSQL = `
      SELECT
        MAX(latest_check_date) AS last_checked,
        MIN(baseline_date)     AS baseline_date,
        next_semester
      FROM \`${P}.${D}.renewal_status\`
      WHERE ending_semester = '${esc(semester)}'
      GROUP BY next_semester
      LIMIT 1
    `;

    const [summary, byBranch, detail, meta] = await Promise.all([
      bqQuery(summarySQL),
      bqQuery(byBranchSQL),
      bqQuery(detailSQL),
      bqQuery(metaSQL),
    ]);

    // Every field that reaches the browser goes through serializeBQRows
    // first, so DATE/NUMERIC/INT64 wrapper objects never leak into JSX.
    return NextResponse.json(
      serializeBQRows({ summary, byBranch, detail, meta: meta[0] || null })
    );

  } catch (err: any) {
    console.error("[/api/renewal]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
