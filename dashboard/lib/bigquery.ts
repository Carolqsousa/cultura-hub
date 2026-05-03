import { BigQuery } from "@google-cloud/bigquery";

export const DATASET = "cultura_hub";
export const PROJECT = process.env.GCP_PROJECT_ID || "";

let _client: BigQuery | null = null;

function getClient() {
  if (_client) return _client;
  
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credsJson) {
    const creds = JSON.parse(credsJson);
    _client = new BigQuery({ projectId: PROJECT, credentials: creds });
  } else {
    _client = new BigQuery({ projectId: PROJECT });
  }
  return _client;
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  try {
    const [rows] = await getClient().query(sql);
    return rows as T[];
  } catch (e) {
    console.error("BigQuery error:", e);
    return [];
  }
}

export function branchFilter(branch: string) {
  if (!branch || branch === "all") return "1=1";
  return `branch = '${branch}'`;
}
