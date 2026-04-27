import { query, DATASET } from "@/lib/bigquery";
import { branchFilter, SessionUser } from "@/lib/auth";

export async function getTeacherStats(user: SessionUser, teacher?: string) {
  const teacherClause = teacher ? `AND d.teacher = '${teacher}'` : "";
  const sql = `
    SELECT
      d.branch,
      d.teacher,
      ROUND(SUM(d.completed) / NULLIF(SUM(d.total_lessons), 0) * 100, 1) AS diary_pct,
      SUM(ta.classes_missed)    AS classes_missed,
      SUM(ta.late_arrivals)     AS late_arrivals,
      SUM(ta.trainings_attended)AS trainings_attended,
      AVG(n.score)              AS nps_score
    FROM \`${DATASET}.diary_checks\` d
    LEFT JOIN \`${DATASET}.teacher_attendance\` ta
           ON d.teacher = ta.teacher AND d.branch = ta.branch AND d.date = ta.date
    LEFT JOIN \`${DATASET}.nps\` n
           ON d.teacher = n.teacher AND d.branch = n.branch
    WHERE d.date = CURRENT_DATE()
      AND ${branchFilter(user, "d")}
      ${teacherClause}
    GROUP BY d.branch, d.teacher
    ORDER BY d.branch, d.teacher
  `;
  return query(sql);
}
