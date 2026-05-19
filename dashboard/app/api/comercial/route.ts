import { query, DATASET } from "@/lib/bigquery";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const responsible = searchParams.get("responsible") || "all";
  const unit = searchParams.get("unit") || "all";
  const dateFrom = searchParams.get("from") || "";
  const dateTo = searchParams.get("to") || "";

  const respFilter = responsible !== "all" ? `AND responsible = '${responsible.replace(/'/g, "''")}'` : "";
  const unitFilter = unit !== "all" ? `AND unit_interest = '${unit.replace(/'/g, "''")}'` : "";
  const dateFromFilter = dateFrom ? `AND created_at >= '${dateFrom}'` : "";
  const dateToFilter = dateTo ? `AND created_at <= '${dateTo}'` : "";
  const filters = `${respFilter} ${unitFilter} ${dateFromFilter} ${dateToFilter}`;

  const latest = `(SELECT MAX(date) FROM \`${DATASET}.leads\`)`;

  const [kpi, byStage, byResponsible, bySource, byTemperature, lossReasons,
    monthlyVolume, lateTasks, responsibles, units] = await Promise.all([

    // KPI summary
    query(`
      SELECT
        COUNT(*) as total_leads,
        COUNTIF(status = 'won') as vendas,
        COUNTIF(status = 'lost') as perdidos,
        COUNTIF(status = 'open') as em_andamento,
        COUNTIF(status = 'paused') as pausados,
        COUNTIF(scheduled = true) as agendados,
        COUNTIF(attended = true) as compareceram,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as taxa_conversao,
        ROUND(COUNTIF(status = 'lost') / NULLIF(COUNT(*), 0) * 100, 1) as taxa_descarte,
        ROUND(COUNTIF(scheduled = true) / NULLIF(COUNT(*), 0) * 100, 1) as taxa_agendamento,
        ROUND(COUNTIF(attended = true) / NULLIF(COUNTIF(scheduled = true), 0) * 100, 1) as taxa_comparecimento,
        ROUND(AVG(CASE WHEN status = 'won' AND tmv_days IS NOT NULL THEN tmv_days END), 1) as tmv_medio
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest}
      AND record_type = 'deal'
      ${filters}
    `),

    // By funnel stage
    query(`
      SELECT stage, COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        COUNTIF(status = 'lost') as perdidos,
        COUNTIF(status = 'open') as em_andamento,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND stage IS NOT NULL AND stage != ''
      ${filters}
      GROUP BY stage ORDER BY total DESC
    `),

    // By responsible
    query(`
      SELECT responsible,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        COUNTIF(status = 'lost') as perdidos,
        COUNTIF(status = 'open') as em_andamento,
        COUNTIF(scheduled = true) as agendados,
        COUNTIF(attended = true) as compareceram,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao,
        ROUND(COUNTIF(scheduled = true) / NULLIF(COUNT(*), 0) * 100, 1) as taxa_agend,
        ROUND(AVG(CASE WHEN status = 'won' AND tmv_days IS NOT NULL THEN tmv_days END), 1) as tmv_medio
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND responsible IS NOT NULL AND responsible != ''
      ${filters}
      GROUP BY responsible ORDER BY total DESC
    `),

    // By source
    query(`
      SELECT source,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND source IS NOT NULL AND source != ''
      ${filters}
      GROUP BY source ORDER BY total DESC
      LIMIT 10
    `),

    // By temperature
    query(`
      SELECT temperature,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND temperature IS NOT NULL AND temperature != ''
      ${filters}
      GROUP BY temperature ORDER BY total DESC
    `),

    // Loss reasons
    query(`
      SELECT loss_reason,
        COUNT(*) as total
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND status = 'lost'
      AND loss_reason IS NOT NULL AND loss_reason != ''
      ${filters}
      GROUP BY loss_reason ORDER BY total DESC
      LIMIT 10
    `),

    // Monthly volume last 12 months
    query(`
      SELECT
        FORMAT_DATE('%Y-%m', created_at) as month,
        COUNT(*) as total,
        COUNTIF(status = 'won') as vendas,
        COUNTIF(status = 'lost') as perdidos,
        ROUND(COUNTIF(status = 'won') / NULLIF(COUNT(*), 0) * 100, 1) as conversao,
        ROUND(AVG(CASE WHEN status = 'won' AND tmv_days IS NOT NULL THEN tmv_days END), 1) as tmv_medio
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
      ${filters}
      GROUP BY month ORDER BY month ASC
    `),

    // Late tasks by user
    query(`
      SELECT responsible,
        COUNT(*) as late_tasks,
        ROUND(AVG(days_late), 1) as avg_days_late,
        MAX(days_late) as max_days_late,
        COUNTIF(days_late > 7) as very_late
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'late_task'
      AND responsible IS NOT NULL AND responsible != ''
      GROUP BY responsible ORDER BY late_tasks DESC
    `),

    // Filter options - responsibles
    query(`
      SELECT DISTINCT responsible
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND responsible IS NOT NULL AND responsible != ''
      ORDER BY responsible
    `),

    // Filter options - units
    query(`
      SELECT DISTINCT unit_interest
      FROM \`${DATASET}.leads\`
      WHERE date = ${latest} AND record_type = 'deal'
      AND unit_interest IS NOT NULL AND unit_interest != ''
      ORDER BY unit_interest
    `),
  ]);

  const totalLateTasks = lateTasks.reduce((s: number, r: any) => s + Number(r.late_tasks), 0);
  const kpiData = kpi[0] || {};

  return Response.json({
    kpi: { ...kpiData, total_late_tasks: totalLateTasks },
    byStage, byResponsible, bySource, byTemperature,
    lossReasons, monthlyVolume, lateTasks,
    filters: {
      responsibles: responsibles.map((r: any) => r.responsible),
      units: units.map((r: any) => r.unit_interest),
    },
  });
}
