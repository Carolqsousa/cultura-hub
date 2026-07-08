// dashboard/app/api/commercial-natal/route.ts
//
// WHAT THIS FILE DOES:
// Serves all data for the /commercial-natal page from BigQuery.
//
// NATAL-SPECIFIC: reads from leads_natal / tasks_natal, NOT leads / tasks.
// Natal uses a completely separate RD Station account -- see
// pipeline/run_leads_natal.py for why this data lives in its own tables
// instead of being merged into the main ones (deal_id collision risk).
// Runs 8 queries in parallel, each returning one "shape" of data
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
// FUNNEL MAPPING — now driven by pipeline_name, not unit_interest:
//   unit_interest was free text typed into RD Station — inconsistent casing,
//   no guarantee it matched a real funnel. pipeline_name is resolved server-side
//   in the pipeline from RD Station's /deal_pipelines endpoint, so it's already
//   one of a known, controlled set of funnel names. We no longer need a CASE
//   statement to guess which bucket a row belongs to.
//
// RISK — historical rows have no funnel:
//   pipeline_name was only added going forward. Every row written before the
//   fix has pipeline_name = NULL. We label those 'Sem Funil (Histórico)'
//   instead of silently excluding them from funnel filters — a silent drop
//   here would understate historical totals without any error to notice.
//
// RISK — tipo is a new, sparsely-filled field:
//   Only ~34% of deals have `tipo` set in RD Station. It is NOT used as a
//   filter or grouping in this file yet — filtering on it would silently
//   exclude the other 66% of deals. Treat it as an optional dimension to add
//   later, with NULL handled explicitly, not as a required field.

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
    console.error("[/api/commercial-natal] BigQuery error:", e);
    throw e;
  }
}

// Safe string escaping — prevents SQL injection from filter params.
// RISK: Never interpolate user input directly into SQL strings without this.
// We use this instead of BigQuery parameterized queries because the @param
// syntax doesn't work well with QUALIFY and complex CTEs in some SDK versions.
function esc(v: string) { return v.replace(/'/g, "''"); }

// ── Funnel resolution ──────────────────────────────────────────────────────────
// pipeline_name comes pre-resolved from the pipeline (via RD Station's
// /deal_pipelines endpoint), so there's no casing/mapping guesswork left to do
// here — just a NULL-safe label for rows written before pipeline_name existed.
// Centralizing it in one constant means if the historical label ever needs to
// change, it changes in exactly one place.
const FUNNEL_EXPR = `COALESCE(NULLIF(TRIM(pipeline_name), ''), 'Sem Funil (Histórico)')`;

// ── Base CTE ──────────────────────────────────────────────────────────────────
// Every query in this file starts with this CTE (Common Table Expression).
// A CTE is like a named subquery — think of it as a temporary clean table
// that exists only for the duration of this query.
//
// What it does:
//   1. Filters to the requested date range
//   2. Deduplicates to one row per deal (most recent snapshot)
//   3. Adds the resolved funnel column
//   4. Optionally filters by funnel and/or responsible
//
// FIX — record_type filter removed:
//   The old CTE filtered `WHERE record_type = 'deal'`. That column was
//   dropped from the leads table in the RD Station migration (tasks now
//   live in their own `tasks` table, so every leads row is already a deal).
//   Leaving that filter in would make every query in this file fail with a
//   "column not found" error — it wasn't just stale, it was a hard break.
//
// PERFORMANCE NOTE: The WHERE clause runs BEFORE QUALIFY in BigQuery's
// execution order. This means we filter down to a small date range FIRST,
// then deduplicate that smaller set. This is much faster than deduplicating
// all 214k rows and then filtering.
function baseCTE(startDate: string, endDate: string, funnel: string, responsible: string) {
  const funnelFilter = funnel !== "all"
    ? `AND ${FUNNEL_EXPR} = '${esc(funnel)}'`
    : "";
  const respFilter = responsible !== "all"
    ? `AND responsible = '${esc(responsible)}'`
    : "";

  return `
    WITH latest_deals AS (
      SELECT *,
        ${FUNNEL_EXPR} AS funnel
      FROM \`${PROJECT}.${DATASET}.leads_natal\`
      WHERE created_at BETWEEN DATE('${esc(startDate)}') AND DATE('${esc(endDate)}')
        ${funnelFilter}
        ${respFilter}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY deal_id ORDER BY date DESC) = 1
    )
  `;
}

// ── Filter options CTE ───────────────────────────────────────────────────────
// Deliberately SEPARATE from baseCTE, and must stay that way.
//
// THE BUG THIS PREVENTS: baseCTE applies the current funnel/responsible
// selections. If the "what options exist" query (below, Query 7) reused
// baseCTE, then the moment a user selected one funnel, this query would
// only see rows already narrowed to that funnel -- so every OTHER funnel
// would silently vanish from the dropdown. The user would have to reset to
// "all" just to see the other options again. Same failure shape as
// "options computed from an already-filtered result" bugs found elsewhere
// in this project's data pipelines today -- no error, just quietly wrong,
// and only noticeable once someone actually uses the filter.
//
// This CTE only ever applies the date range -- never funnel, never
// responsible -- so both dropdowns always show every option valid for the
// selected date range, regardless of what's currently selected in either.
function filterOptionsCTE(startDate: string, endDate: string) {
  return `
    WITH latest_deals AS (
      SELECT *,
        ${FUNNEL_EXPR} AS funnel
      FROM \`${PROJECT}.${DATASET}.leads_natal\`
      WHERE created_at BETWEEN DATE('${esc(startDate)}') AND DATE('${esc(endDate)}')
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

    // ── Query 8: Late tasks by responsible ─────────────────────────────────
    // Was on the old Portuguese /comercial page ("Tarefas atrasadas por
    // atendente"), dropped during the rebuild to pipeline_name -- adding
    // it back here, in the new schema.
    //
    // WHY THIS DOESN'T REUSE `base`:
    //   `base` is built from the `leads` table. Late tasks live in a
    //   separate `tasks` table (different shape entirely -- see tasks.py's
    //   own docstring on why leads/tasks aren't merged into one table).
    //
    // WHY THIS DOESN'T USE QUALIFY ROW_NUMBER() LIKE OTHER QUERIES:
    //   Every other query dedupes to "most recent snapshot per deal_id"
    //   because a deal only has ONE current state. Tasks are different: one
    //   deal can have SEVERAL late tasks open at once. Partitioning by
    //   deal_id and keeping only 1 row would silently discard every task
    //   but one per deal -- wrong for a completely different reason than
    //   "duplicate data", so it needs different handling, not the same
    //   pattern copy-pasted.
    //
    // WHAT "CURRENT" MEANS HERE: the tasks table is a full daily rebuild --
    // each day's rows ARE that day's complete list of currently-late tasks
    // (see tasks.py: it only ever emits tasks that are overdue right now).
    // So "late tasks" is inherently a snapshot-in-time question, not a
    // date-range question like leads volume is. This shows the MOST RECENT
    // snapshot on or before the selected end date, not a sum across the
    // whole range -- summing daily snapshots would massively overcount,
    // since the same overdue task appears again in every day's snapshot
    // until it's resolved.
    const lateTasksSQL = `
      WITH latest_task_date AS (
        SELECT MAX(date) AS d
        FROM \`${PROJECT}.${DATASET}.tasks_natal\`
        WHERE date <= DATE('${esc(endDate)}')
      ),
      latest_tasks AS (
        SELECT t.*
        FROM \`${PROJECT}.${DATASET}.tasks_natal\` t, latest_task_date
        WHERE t.date = latest_task_date.d
          ${funnel !== "all" ? `AND ${FUNNEL_EXPR} = '${esc(funnel)}'` : ""}
          ${responsible !== "all" ? `AND responsible = '${esc(responsible)}'` : ""}
      )
      SELECT
        COALESCE(NULLIF(TRIM(responsible), ''), 'Sem Responsável') AS responsible,
        COUNT(*)                          AS total,
        COUNTIF(days_late >= 7)           AS over_7d,
        MAX(days_late)                    AS max_days_late,
        ROUND(AVG(days_late), 1)          AS avg_days_late
      FROM latest_tasks
      GROUP BY responsible
      ORDER BY total DESC
    `;

    // ── Query 7: Available filters ─────────────────────────────────────────
    // Returns every funnel/responsible that has data in the FULL date
    // range -- deliberately ignoring whatever funnel/responsible is
    // currently selected. Uses filterOptionsCTE, NOT `base` (which every
    // other query above uses). See filterOptionsCTE's comment for why
    // reusing `base` here would be a bug: it would make the dropdown
    // options shrink to match whatever's currently selected, instead of
    // always showing the full set of choices.
    const filtersSQL = `
      ${filterOptionsCTE(startDate, endDate)}
      SELECT
        funnel,
        responsible,
        COUNT(*) AS total
      FROM latest_deals
      GROUP BY funnel, responsible
      ORDER BY funnel, total DESC
    `;

    // Run all 8 queries in parallel.
    // Promise.all waits for ALL to complete before returning.
    // If ANY query fails, the entire request fails — we don't return
    // partial data that would confuse the user.
    // RISK: If one slow query blocks the page, consider splitting into
    // separate API routes for above-the-fold (KPIs) and below-the-fold (charts).
    const [kpis, monthly, bySource, byResponsible, lossReasons, cohort, lateTasks, filters] =
      await Promise.all([
        bqQuery(kpisSQL),
        bqQuery(monthlySQL),
        bqQuery(bySourceSQL),
        bqQuery(byResponsibleSQL),
        bqQuery(lossReasonsSQL),
        bqQuery(cohortSQL),
        bqQuery(lateTasksSQL),
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

    return NextResponse.json(serializeBQRows({
      kpis:            kpis[0] || {},
      monthly,
      bySource,
      byResponsible,
      lossReasons,
      cohort,
      lateTasks,
      availableFunnels:      Array.from(funnelSet).sort(),
      availableResponsibles: Array.from(respSet).sort(),
      meta: {
        startDate,
        endDate,
        funnel,
        responsible,
        generatedAt: new Date().toISOString(),
      },
    }));

  } catch (err: any) {
    console.error("[/api/commercial-natal]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
