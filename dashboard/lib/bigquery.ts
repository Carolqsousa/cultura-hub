/**
 * Server-side BigQuery client for Next.js API routes / Server Components.
 * Never import this in client components.
 */
import { BigQuery } from "@google-cloud/bigquery";

const PROJECT_ID = process.env.GCP_PROJECT_ID!;
const DATASET = process.env.BQ_DATASET ?? "cultura_hub";

let _bq: BigQuery | null = null;

export function getBQ(): BigQuery {
  if (!_bq) {
    _bq = new BigQuery({ projectId: PROJECT_ID });
  }
  return _bq;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const bq = getBQ();
  const [rows] = await bq.query({ query: sql, params });
  return rows as T[];
}

export { DATASET, PROJECT_ID };
