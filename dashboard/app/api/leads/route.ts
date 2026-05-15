import { query, DATASET } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

export async function GET() {
  const [summary, byStage, byResponsible, lateTasks, monthlyVolume] = await Promise.all([

    // KPI summary
    query(`
      SELECT
        COUNT(*) as total_leads,
        COUNTIF(status = 'won') as vendas,
        COUNTIF(status = 'lost') as perdidos,
        COUNTIF(status = 'open') as em_andamento,
        COUNTIF(status = 'paused') as pausados,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as taxa_conversao,
        ROUND(COUNTIF(status = 'lost') / NULLIF(COUNT(*), 0) * 100, 1) as taxa_descarte,
        ROUND(
          AVG(CASE WHEN status = 'won' AND closed_at IS NOT NULL
            THEN DATE_DIFF(CAST(closed_at AS DATE), CAST(created_at AS DATE), DAY)
            ELSE NULL END), 1
        ) as tmv_medio
      FROM \`${DATASET}.leads\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.leads\`)
      AND record_type = 'deal'
    `),

    // Leads by funnel stage
    query(`
      SELECT
        stage,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao
      FROM \`${DATASET}.leads\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.leads\`)
      AND record_type = 'deal'
      AND stage IS NOT NULL
      GROUP BY stage
      ORDER BY total DESC
    `),

    // Performance by responsible
    query(`
      SELECT
        responsible,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        COUNTIF(status = 'lost') as perdidos,
        COUNTIF(status = 'open') as em_andamento,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao
      FROM \`${DATASET}.leads\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.leads\`)
      AND record_type = 'deal'
      AND responsible IS NOT NULL AND responsible != ''
      GROUP BY responsible
      ORDER BY total DESC
    `),

    // Late tasks by user
    query(`
      SELECT
        responsible,
        COUNT(*) as late_tasks,
        ROUND(AVG(days_late), 1) as avg_days_late,
        MAX(days_late) as max_days_late
      FROM \`${DATASET}.leads\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.leads\`)
      AND record_type = 'late_task'
      AND responsible IS NOT NULL AND responsible != ''
      GROUP BY responsible
      ORDER BY late_tasks DESC
    `),

    // Monthly volume (last 6 months)
    query(`
      SELECT
        FORMAT_DATE('%Y-%m', created_at) as month,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao
      FROM \`${DATASET}.leads\`
      WHERE date = (SELECT MAX(date) FROM \`${DATASET}.leads\`)
      AND record_type = 'deal'
      AND created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)
      GROUP BY month
      ORDER BY month ASC
    `),
  ]);

  const kpi = summary[0] || {};
  const totalLateTasks = lateTasks.reduce((s: number, r: any) => s + Number(r.late_tasks), 0);

  return Response.json({
    kpi: { ...kpi, total_late_tasks: totalLateTasks },
    byStage,
    byResponsible,
    lateTasks,
    monthlyVolume,
  });
}
