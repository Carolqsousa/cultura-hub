import { query, DATASET } from "@/lib/bigquery";
import { branchFilter, SessionUser } from "@/lib/auth";

export async function getStudentSummary(user: SessionUser) {
  const sql = `
    SELECT
      branch,
      COUNT(*)                                    AS active_count,
      AVG(discount_percent)                       AS avg_discount,
      AVG(monthly_value)                          AS avg_ticket,
      SUM(monthly_value)                          AS atp
    FROM \`${DATASET}.students\`
    WHERE date = CURRENT_DATE()
      AND status = 'active'
      AND ${branchFilter(user)}
    GROUP BY branch
    ORDER BY branch
  `;
  return query(sql);
}

export async function getAtRiskStudents(user: SessionUser) {
  const sql = `
    SELECT
      s.branch,
      s.student_id,
      s.name,
      s.teacher,
      f.months_behind,
      a.presence_rate,
      g.average
    FROM \`${DATASET}.students\` s
    LEFT JOIN \`${DATASET}.financials\`  f ON s.student_id = f.student_id AND f.date = CURRENT_DATE()
    LEFT JOIN \`${DATASET}.attendance\`  a ON s.student_id = a.student_id AND a.date = CURRENT_DATE()
    LEFT JOIN \`${DATASET}.grades\`      g ON s.student_id = g.student_id AND g.date = CURRENT_DATE()
    WHERE s.date = CURRENT_DATE()
      AND s.status = 'active'
      AND ${branchFilter(user, "s")}
      AND (f.months_behind >= 1 OR a.presence_rate < 0.75 OR g.average < 5)
    ORDER BY s.branch, s.name
  `;
  return query(sql);
}
