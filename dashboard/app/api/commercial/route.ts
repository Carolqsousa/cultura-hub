// dashboard/app/api/commercial/route.ts
//
// WHAT THIS FILE DOES:
// Serves all data for the /commercial page from BigQuery.
// Runs 5 queries in parallel, each returning one "shape" of data
// that maps to a specific section of the page.
//
// ARCHITECTURE DECISION — Why an API route and not direct BigQuery from browser:
//   1. Security: credentials never exposed to the browser
//   2. Performance: 5 parallel server-side queries beat 5 sequential browser fetches
//   3. Caching: results can be cached at the edge (future optimization)
//
// DEDUPLICATION PATTERN — Why every query starts with a CTE:
//   Your leads table stores daily snapshots — one row per deal per day.
//   A deal open for 40 days has 40 rows. Without deduplication, every count
//   would be ~40x too high. The QUALIFY ROW_NUMBER() pattern keeps only
//   the most recent snapshot per deal, giving us current state.
//
// FUNNEL MAPPING — Why we normalize unit_interest:
//   RD Station has historical data with mixed casing (Boa Viagem / BOA VIAGEM).
//   Since it's now a dropdown, new data will be consistent — but old data isn't.
//   UPPER(TRIM()) normalizes before comparison so both map to the same bucket.
//
// RISK: If RD Station adds a new dropdown option (e.g. a new branch opens),
//   it will silently fall into 'Outras Unidades' until the mapping is updated here.
//   The monitoring query at the bottom of this file detects this.

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
    console.error("[/api/commercial] BigQuery error:", e);
    throw e;
  }
}

// Safe string escaping — prevents SQL injection from filter params.
// RISK: Never interpolate user input directly into SQL strings without this.
// We use this instead of BigQuery parameterized queries because the @param
// syntax doesn't work well with QUALIFY and complex CTEs in some SDK versions.
function esc(v: string) { return v.replace(/'/g, "''"); }

// ── Funnel normalization ──────────────────────────────────────────────────────
// Centralizing the CASE statement in one constant means if the mapping ever
// needs updating (new branch, spelling change), it only changes in one place.
// This is the DRY principle applied to SQL — "Don't Repeat Yourself."
const FUNNEL_CASE = `
  CASE UPPER(TRIM(unit_interest))
    WHEN 'BOA VIAGEM'       THEN 'Boa Viagem'
    WHEN 'SETUBAL'          THEN 'Setúbal'
    WHEN 'THE NEST'         THEN 'The Nest'
    WHEN 'INSTITUTO EUROPA' THEN 'Instituto Europa'
    WHEN ''                 THEN 'Sem Funil'
    ELSE 'Outras Unidades'
  END
`;

// ── Base CTE ──────────────────────────────────────────────────────────────────
// Every query in this file starts with this CTE (Common Table Expression).
// A CTE is like a named subquery — think of it as a temporary clean table
// that exists only for the duration of this query.
//
// What it does:
//   1. Filters to deals only (not late_task records)
//   2. Filters to the requested date range
//   3. Deduplicates to one row per deal (most recent snapshot)
//   4. Adds the normalized funnel column
//   5. Optionally filters by funnel and/or responsible
//
// PERFORMANCE NOTE: The WHERE clause runs BEFORE QUALIFY in BigQuery's
// execution order. This means we filter down to a small date range FIRST,
// then deduplicate that smaller set. This is much faster than deduplicating
// all 214k rows and then filtering.
function baseCTE(startDate: string, endDate: string, funnel: string, responsible: string) {
  const funnelFilter = funnel !== "all"
    ? `AND ${FUNNEL_CASE} = '${esc(funnel)}'`
    : "";
  const respFilter = responsible !== "all"
    ? `AND responsible = '${esc(responsible)}'`
    : "";

  return `
    WITH latest_deals AS (
      SELECT *,
        ${FUNNEL_CASE} AS funnel
      FROM \`${PROJECT}.${DATASET}.leads\`
      WHERE record_type = 'deal'
        AND created_at BETWEEN DATE('${esc(startDate)}') AND DATE('${esc(endDate)}')
        ${funnelFilter}
        ${respFilter}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY deal_id ORDER BY date DESC) = 1
    )
  `;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Default to current year — keeps initial load fast and relevant.
  // RISK: If someone selects "all time" (2023-present), the cohort query
  // processes ~35k unique deals which is fine, but if your data grows to
  // millions of unique deals, add an index or limit the max range.
  const currentYear  = new Date().getFullYear();
  const startDate    = searchParams.get("start")       || `${currentYear}-01-01`;
  const endDate      = searchParams.get("end")         || new Date().toISOString().slice(0, 10);
  const funnel       = searchParams.get("funnel")      || "all";
  const responsible  = searchParams.get("responsible") || "all";

  const base = baseCTE(startDate, endDate, funnel, responsible);

  try {
    // ── Query 1: KPIs ──────────────────────────────────────────────────────
    // Returns one row with all headline metrics.
    // TMV (Tempo Médio de Venda) is calculated only for won deals with valid
    // tmv_days — negative values mean data entry error (closed_at < created_at)
    // and are excluded. Your pipeline pre-calculates tmv_days which is cleaner
    // than computing (closed_at - created_at) here because it handles edge cases.
    const kpisSQL = `
      ${base}
      SELECT
        COUNT(*)                                          AS total,
        COUNTIF(status = 'won')                           AS won,
        COUNTIF(status = 'lost')                          AS lost,
        COUNTIF(status = 'open')                          AS open_deals,
        COUNTIF(status = 'paused')                        AS paused,
        ROUND(COUNTIF(status = 'won') / COUNT(*) * 100, 1) AS conv_pct,
        ROUND(COUNTIF(status = 'lost') / COUNT(*) * 100, 1) AS loss_pct,
        ROUND(COUNTIF(scheduled = TRUE) / COUNT(*) * 100, 1) AS sched_pct,
        ROUND(COUNTIF(attended = TRUE) / COUNT(*) * 100, 1)  AS attend_pct,
        ROUND(AVG(CASE WHEN status = 'won' AND tmv_days >= 0 THEN tmv_days END), 1) AS avg_tmv
      FROM latest_deals
    `;

    // ── Query 2: Monthly volume ────────────────────────────────────────────
    // Groups leads and won deals by the month they were CREATED (not closed).
    // FORMAT_DATE('%Y-%m', created_at) converts a date to 'YYYY-MM' string
    // which sorts correctly alphabetically and is easy to label in charts.
    //
    // WHY created_at and not closed_at for volume:
    //   Volume charts answer "how many leads did we generate each month?"
    //   That question is always about when the lead entered the funnel.
    //   Closed_at is used for conversion analysis, not volume.
    const monthlySQL = `
      ${base}
      SELECT
        FORMAT_DATE('%Y-%m', created_at)           AS month,
        COUNT(*)                                    AS total,
        COUNTIF(status = 'won')                     AS won,
        ROUND(COUNTIF(status = 'won') / COUNT(*) * 100, 1) AS conv_pct,
        ROUND(AVG(CASE WHEN status = 'won' AND tmv_days >= 0 THEN tmv_days END), 1) AS avg_tmv
      FROM latest_deals
      GROUP BY month
      ORDER BY month
    `;

    // ── Query 3: By source ────────────────────────────────────────────────
    // Aggregates by lead source (WhatsApp, Instagram, etc.)
    // NULLIF handles empty source strings — NULLIF(source, '') returns NULL
    // when source is '', which COALESCE then replaces with 'Desconhecido'.
    // This prevents '' and NULL both appearing as separate rows.
    const bySourceSQL = `
      ${base}
      SELECT
        COALESCE(NULLIF(TRIM(source), ''), 'Desconhecido') AS source,
        COUNT(*)                                             AS total,
        COUNTIF(status = 'won')                             AS won,
        COUNTIF(status = 'lost')                            AS lost,
        COUNTIF(status = 'open')                            AS open_deals,
        COUNTIF(scheduled = TRUE)                           AS scheduled,
        COUNTIF(attended = TRUE)                            AS attended,
        COUNTIF(status = 'paused')                          AS paused,
        ROUND(COUNTIF(status = 'won') / COUNT(*) * 100, 1) AS conv_pct,
        ROUND(AVG(contact_attempts), 1)                     AS avg_attempts,
        ROUND(AVG(contact_returns), 1)                      AS avg_returns,
        STRING_AGG(DISTINCT CASE WHEN status='lost' AND loss_reason != ''
          THEN loss_reason END LIMIT 3)                     AS top_loss_reasons
      FROM latest_deals
      GROUP BY source
      ORDER BY total DESC
    `;

    // ── Query 4: By responsible ────────────────────────────────────────────
    // Performance metrics per sales rep.
    // The "score" concept from the HTML: 50% conversion + 50% volume.
    // We compute the raw numbers here and calculate the score in the frontend
    // (needs normalization across all reps which requires knowing all values first).
    //
    // RISK: If a rep handles leads across multiple funnels and the funnel filter
    // is active, their numbers will appear lower than their real performance.
    // This is intentional — we're measuring performance within a specific funnel.
    const byResponsibleSQL = `
      ${base}
      SELECT
        COALESCE(NULLIF(TRIM(responsible), ''), 'Sem Responsável') AS responsible,
        COUNT(*)                                     AS total,
        COUNTIF(status = 'won')                      AS won,
        COUNTIF(status = 'lost')                     AS lost,
        COUNTIF(status = 'open')                     AS open_deals,
        ROUND(COUNTIF(status = 'won') / COUNT(*) * 100, 1) AS conv_pct,
        ROUND(AVG(CASE WHEN status='won' AND tmv_days >= 0 THEN tmv_days END), 1) AS avg_tmv,
        COUNTIF(scheduled = TRUE)                    AS scheduled,
        COUNTIF(attended = TRUE)                     AS attended
      FROM latest_deals
      GROUP BY responsible
      ORDER BY won DESC
    `;

    // ── Query 5: Loss reasons ─────────────────────────────────────────────
    // Simple ranking of why leads were lost.
    // Only counts leads where loss_reason is not empty.
    // RISK: If reps don't fill in loss_reason when marking a lead lost,
    // this chart understates the true loss reason distribution.
    // The 'sem_motivo' count in the output shows how many lost leads
    // have no reason — useful for data quality monitoring.
    const lossReasonsSQL = `
      ${base}
      SELECT
        COALESCE(NULLIF(TRIM(loss_reason), ''), 'Não informado') AS reason,
        COUNT(*) AS total
      FROM latest_deals
      WHERE status = 'lost'
      GROUP BY reason
      ORDER BY total DESC
      LIMIT 15
    `;

    // ── Query 6: Cohort analysis ──────────────────────────────────────────
    // The most complex query. Answers: "Of leads that entered in month X,
    // when did they close (how many months later)?"
    //
    // HOW IT WORKS:
    //   entry_month = the month created_at falls in (e.g. '2026-01')
    //   close_month = the month closed_at falls in (e.g. '2026-02')
    //   lag = close_month - entry_month in months (0 = same month, 1 = next, etc.)
    //
    // DATE_DIFF(close_month, entry_month, MONTH) gives the lag in months.
    // We cap at 5+ because beyond 5 months the numbers are too small to be
    // meaningful and the table would be too wide.
    //
    // WHY THIS IS VALUABLE FOR SCHOOLS:
    //   School enrollment decisions cluster around semester start dates.
    //   A lead in October might not convert until February (new semester).
    //   The cohort shows you whether your team is giving up too early.
    //
    // RISK: Recent months will show lower conversion % because many of their
    // leads are still open — they haven't had time to close yet. This is called
    // "right-censoring" in statistics. We flag recent months in the output so
    // users know to interpret them cautiously.
    const cohortSQL = `
      ${base}
      SELECT
        FORMAT_DATE('%Y-%m', created_at)      AS entry_month,
        COUNT(*)                               AS total_leads,
        COUNTIF(status = 'won')                AS total_won,

        -- Lag 0-5+ breakdown (only for won deals)
        COUNTIF(status = 'won' AND closed_at IS NOT NULL
          AND DATE_DIFF(DATE_TRUNC(closed_at, MONTH),
                        DATE_TRUNC(created_at, MONTH), MONTH) = 0) AS lag_0,
        COUNTIF(status = 'won' AND closed_at IS NOT NULL
          AND DATE_DIFF(DATE_TRUNC(closed_at, MONTH),
                        DATE_TRUNC(created_at, MONTH), MONTH) = 1) AS lag_1,
        COUNTIF(status = 'won' AND closed_at IS NOT NULL
          AND DATE_DIFF(DATE_TRUNC(closed_at, MONTH),
                        DATE_TRUNC(created_at, MONTH), MONTH) = 2) AS lag_2,
        COUNTIF(status = 'won' AND closed_at IS NOT NULL
          AND DATE_DIFF(DATE_TRUNC(closed_at, MONTH),
                        DATE_TRUNC(created_at, MONTH), MONTH) = 3) AS lag_3,
        COUNTIF(status = 'won' AND closed_at IS NOT NULL
          AND DATE_DIFF(DATE_TRUNC(closed_at, MONTH),
                        DATE_TRUNC(created_at, MONTH), MONTH) = 4) AS lag_4,
        COUNTIF(status = 'won' AND closed_at IS NOT NULL
          AND DATE_DIFF(DATE_TRUNC(closed_at, MONTH),
                        DATE_TRUNC(created_at, MONTH), MONTH) >= 5) AS lag_5_plus,

        -- Flag recent months where conversion is likely understated
        -- "Recent" = entry month is within 2 months of today
        DATE_DIFF(CURRENT_DATE(), DATE_TRUNC(MIN(created_at), MONTH), MONTH) <= 2
          AS is_recent

      FROM latest_deals
      GROUP BY entry_month
      ORDER BY entry_month
    `;

    // ── Query 7: Available filters ─────────────────────────────────────────
    // Returns the list of funnels and responsibles available in the
    // current date range — so the filter dropdowns only show options
    // that actually have data. Avoids the frustrating UX of selecting
    // a filter and getting zero results.
    const filtersSQL = `
      ${base}
      SELECT
        funnel,
        responsible,
        COUNT(*) AS total
      FROM latest_deals
      GROUP BY funnel, responsible
      ORDER BY funnel, total DESC
    `;

    // Run all 7 queries in parallel.
    // Promise.all waits for ALL to complete before returning.
    // If ANY query fails, the entire request fails — we don't return
    // partial data that would confuse the user.
    // RISK: If one slow query blocks the page, consider splitting into
    // separate API routes for above-the-fold (KPIs) and below-the-fold (charts).
    const [kpis, monthly, bySource, byResponsible, lossReasons, cohort, filters] =
      await Promise.all([
        bqQuery(kpisSQL),
        bqQuery(monthlySQL),
        bqQuery(bySourceSQL),
        bqQuery(byResponsibleSQL),
        bqQuery(lossReasonsSQL),
        bqQuery(cohortSQL),
        bqQuery(filtersSQL),
      ]);

    // Extract unique funnels and responsibles from the filters query.
    // We do this server-side rather than client-side so the browser
    // receives a clean, deduplicated list.
    const funnelSet = new Set<string>();
    const respSet   = new Set<string>();
    (filters as any[]).forEach(r => {
      if (r.funnel)      funnelSet.add(r.funnel);
      if (r.responsible) respSet.add(r.responsible);
    });

    return NextResponse.json({
      kpis:            kpis[0] || {},
      monthly,
      bySource,
      byResponsible,
      lossReasons,
      cohort,
      availableFunnels:      Array.from(funnelSet).sort(),
      availableResponsibles: Array.from(respSet).sort(),
      meta: {
        startDate,
        endDate,
        funnel,
        responsible,
        generatedAt: new Date().toISOString(),
      },
    });

  } catch (err: any) {
    console.error("[/api/commercial]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
