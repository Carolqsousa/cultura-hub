import { query, DATASET } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

// ── Resilience wrapper ──────────────────────────────────────────────────────
// WHY THIS EXISTS: this file makes 10 BigQuery calls across two Promise.all
// batches. Promise.all fails all-or-nothing — one bad query used to be able
// to blank the ENTIRE homepage (academic, financial, operational sections
// included), even though only the commercial-metrics queries were actually
// broken. safeQuery() isolates each call: a failure is logged loudly on the
// server (so it's never silently invisible) but returns an empty result
// instead of throwing, so the rest of the page still renders.
//
// NOTE: this is a different failure philosophy than the pipeline's
// sys.exit(1) pattern, deliberately. The pipeline writes data — it should
// fail loud so nobody trusts a silently-incomplete write. This reads data
// for a live page — it should degrade gracefully per-section so one broken
// metric doesn't take five working ones down with it. Same value (never
// hide a failure), different layer, different correct behavior.
async function safeQuery(sql: string, label: string) {
  try {
    return await query(sql);
  } catch (err) {
    console.error(`[overview] query failed (${label}):`, err);
    return [];
  }
}

function branchFilter(branch: string, field = "branch") {
  return branch !== "all" ? `AND ${field} = '${branch}'` : "";
}

// Maps overview branch names → cancellations_xls branch codes
const BRANCH_TO_XLS: Record<string, string> = {
  "Boa Viagem": "BV",
  "Young":      "YG",
  "Setubal":    "SET",
  "Natal":      "CI Lagoa Nova",
};

function xlsBranchFilter(branch: string) {
  if (branch === "all") return "";
  const code = BRANCH_TO_XLS[branch] || branch;
  return `AND branch = '${code.replace(/'/g, "''")}'`;
}

// Derive current semester from period (YYYY-MM)
function getSemester(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month <= 6 ? `${year}.1` : `${year}.2`;
}

async function fetchPeriodData(period: string, branch: string) {
  const pDate    = `DATE '${period}-01'`;
  const bFilter  = branchFilter(branch);
  // NOTE — unit_interest left untouched deliberately:
  // This field identifies BRANCH (Boa Viagem, Young, Setubal, Natal), not
  // FUNNEL. The RD Station migration's pipeline_name is a funnel label with
  // only 5 values, and "Young"/"Natal" don't appear among them — they likely
  // collapse into a catch-all "Funil OUTRAS UNIDADES" bucket. Swapping this
  // to pipeline_name without confirming that mapping could silently merge
  // Young and Natal's numbers together. Needs a deliberate decision, not a
  // guess — tracked separately from this crash fix.
  const bLeads   = branchFilter(branch, "unit_interest");
  const semester = getSemester(period);

  const [academic, financial, operational, newLeads, conversions, cancellations] = await Promise.all([

    safeQuery(`
      WITH s AS (
        SELECT student_id FROM \`${DATASET}.students\`
        WHERE DATE_TRUNC(date, MONTH) = ${pDate} ${bFilter}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY date DESC) = 1
      ),
      g AS (
        SELECT student_id, overall_average, grade_format FROM \`${DATASET}.grades\`
        WHERE DATE_TRUNC(date, MONTH) = ${pDate}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY date DESC) = 1
      ),
      a AS (
        SELECT student_id, pct_presence FROM \`${DATASET}.attendance\`
        WHERE DATE_TRUNC(date, MONTH) = ${pDate}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY date DESC) = 1
      )
      SELECT
        COUNT(DISTINCT s.student_id)                                                           as total_students,
        COUNTIF(g.overall_average < 7 AND g.grade_format = 'A' AND g.overall_average IS NOT NULL) as at_risk_grade,
        COUNTIF(a.pct_presence < 70 AND a.pct_presence IS NOT NULL)                           as at_risk_attendance
      FROM s
      LEFT JOIN g ON s.student_id = g.student_id
      LEFT JOIN a ON s.student_id = a.student_id
    `, "academic"),

    safeQuery(`
      SELECT
        COUNT(DISTINCT student_id)   as defaulting_students,
        ROUND(SUM(value), 2)         as total_overdue
      FROM \`${DATASET}.financials\`
      WHERE DATE_TRUNC(date, MONTH) = ${pDate} ${bFilter}
    `, "financial"),

    safeQuery(`
      SELECT
        SUM(total_lessons) as total_lessons,
        SUM(completed)     as completed,
        SUM(pending)       as pending
      FROM \`${DATASET}.diary_checks\`
      WHERE DATE_TRUNC(date, MONTH) = ${pDate} ${bFilter}
    `, "operational"),

    // FIX — record_type = 'deal' removed: column was dropped from `leads`
    // in the RD Station migration. This is what was crashing the homepage.
    safeQuery(`
      SELECT COUNT(*) as cnt
      FROM \`${DATASET}.leads\`
      WHERE DATE_TRUNC(created_at, MONTH) = ${pDate} ${bLeads}
    `, "newLeads"),

    // FIX — record_type = 'deal' removed (see above)
    safeQuery(`
      SELECT COUNT(*) as cnt
      FROM \`${DATASET}.leads\`
      WHERE status = 'won'
        AND DATE_TRUNC(CAST(closed_at AS DATE), MONTH) = ${pDate} ${bLeads}
    `, "conversions"),

    // Cancellations from cancellations_xls — real churn only, filtered by month
    safeQuery(`
      SELECT
        COUNT(*)               as total_cancels,
        COUNTIF(is_real_churn) as real_churn
      FROM \`${DATASET}.cancellations_xls\`
      WHERE semester = '${semester}'
        AND DATE_TRUNC(event_date, MONTH) = ${pDate}
        ${xlsBranchFilter(branch)}
    `, "cancellations"),
  ]);

  const ac  = academic[0]      || {};
  const fi  = financial[0]     || {};
  const op  = operational[0]   || {};
  const ca  = cancellations[0] || {};
  const nl  = Number((newLeads[0]    as any)?.cnt || 0);
  const cv  = Number((conversions[0] as any)?.cnt || 0);
  const tot = Number(ac.total_students) || 0;
  const def = Number(fi.defaulting_students) || 0;
  const tl  = Number(op.total_lessons) || 0;
  const co  = Number(op.completed)     || 0;

  return {
    academic: {
      total_students:         tot,
      at_risk_grade:          Number(ac.at_risk_grade)      || 0,
      pct_at_risk_grade:      tot > 0 ? Math.round((Number(ac.at_risk_grade)      || 0) / tot * 100) : 0,
      at_risk_attendance:     Number(ac.at_risk_attendance) || 0,
      pct_at_risk_attendance: tot > 0 ? Math.round((Number(ac.at_risk_attendance) || 0) / tot * 100) : 0,
      cancellations:          Number(ca.total_cancels) || 0,
      real_churn:             Number(ca.real_churn)    || 0,
      pct_churn:              tot > 0 ? Math.round((Number(ca.real_churn) || 0) / tot * 100) : 0,
    },
    financial: {
      total_overdue:       Number(fi.total_overdue) || 0,
      defaulting_students: def,
      pct_defaulting:      tot > 0 ? Math.round(def / tot * 100) : 0,
    },
    operational: {
      total_lessons: tl,
      completed:     co,
      pending:       Number(op.pending) || 0,
      pct_complete:  tl > 0 ? Math.floor(co / tl * 100) : 0,
    },
    commercial: {
      new_leads:       nl,
      conversions:     cv,
      conversion_rate: nl > 0 ? Math.round(cv / nl * 100) : 0,
    },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const branch        = searchParams.get("branch")         || "all";
  const period        = searchParams.get("period")         || new Date().toISOString().slice(0, 7);
  const comparePeriod = searchParams.get("compare_period") || null;
  const bLeads        = branchFilter(branch, "unit_interest"); // see NOTE above — left as-is deliberately

  const [periodData, compareData, top3Sources, top3Sales] = await Promise.all([
    fetchPeriodData(period, branch),
    comparePeriod ? fetchPeriodData(comparePeriod, branch) : Promise.resolve(null),

    // FIX — record_type = 'deal' removed (see fetchPeriodData above)
    safeQuery(`
      SELECT source, COUNT(*) as count
      FROM \`${DATASET}.leads\`
      WHERE created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
        AND source IS NOT NULL AND source != '' ${bLeads}
      GROUP BY source ORDER BY count DESC LIMIT 3
    `, "top3Sources"),

    // FIX — record_type = 'deal' removed (see fetchPeriodData above)
    safeQuery(`
      SELECT responsible, COUNT(*) as total, COUNTIF(status = 'won') as conversions
      FROM \`${DATASET}.leads\`
      WHERE created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
        AND responsible IS NOT NULL AND responsible != '' ${bLeads}
      GROUP BY responsible ORDER BY conversions DESC, total DESC LIMIT 3
    `, "top3Sales"),
  ]);

  return Response.json({
    period, compare_period: comparePeriod,
    data: periodData, compare: compareData,
    top3_sources: top3Sources,
    top3_sales:   top3Sales,
  });
}
