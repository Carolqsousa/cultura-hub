import { query, DATASET } from "@/lib/bigquery";
import { branchFilter, SessionUser } from "@/lib/auth";

export async function getMonthlyRevenue(user: SessionUser) {
  const sql = `
    SELECT
      FORMAT_DATE('%Y-%m', date) AS month,
      branch,
      SUM(amount_paid)           AS revenue,
      SUM(amount_due)            AS billed
    FROM \`${DATASET}.financials\`
    WHERE ${branchFilter(user)}
    GROUP BY month, branch
    ORDER BY month DESC, branch
    LIMIT 120
  `;
  return query(sql);
}

export async function getDelinquency(user: SessionUser) {
  const sql = `
    SELECT
      branch,
      COUNT(*)            AS delinquent_count,
      SUM(amount_due - amount_paid) AS overdue_amount,
      AVG(months_behind)  AS avg_months_behind
    FROM \`${DATASET}.financials\`
    WHERE date = CURRENT_DATE()
      AND status != 'paid'
      AND ${branchFilter(user)}
    GROUP BY branch
    ORDER BY branch
  `;
  return query(sql);
}
