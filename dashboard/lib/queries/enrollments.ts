import { query, DATASET } from "@/lib/bigquery";
import { branchFilter, SessionUser } from "@/lib/auth";

export async function getEnrollmentGoals(user: SessionUser) {
  const sql = `
    SELECT
      semester,
      branch,
      enrollment_goal,
      current_enrollments,
      ROUND(current_enrollments / NULLIF(enrollment_goal, 0) * 100, 1) AS pct
    FROM \`${DATASET}.goals\`
    WHERE ${branchFilter(user)}
    ORDER BY semester DESC, branch
  `;
  return query(sql);
}

export async function getCancellationTrend(user: SessionUser) {
  const sql = `
    SELECT
      FORMAT_DATE('%Y-%m', date) AS month,
      branch,
      COUNT(*)  AS cancellations,
      reason
    FROM \`${DATASET}.cancellations\`
    WHERE ${branchFilter(user)}
    GROUP BY month, branch, reason
    ORDER BY month DESC, branch
    LIMIT 120
  `;
  return query(sql);
}

export async function getLeadPipeline(user: SessionUser) {
  const sql = `
    SELECT
      branch,
      pipeline_stage,
      source,
      SUM(new_leads) AS leads
    FROM \`${DATASET}.leads\`
    WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
      AND ${branchFilter(user)}
    GROUP BY branch, pipeline_stage, source
    ORDER BY branch, leads DESC
  `;
  return query(sql);
}
