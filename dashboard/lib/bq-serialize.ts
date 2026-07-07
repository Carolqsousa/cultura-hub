// dashboard/lib/bq-serialize.ts
//
// The @google-cloud/bigquery driver wraps certain column types (DATE,
// DATETIME, TIMESTAMP, TIME, NUMERIC, BIGNUMERIC, and sometimes INT64) in
// small class instances shaped like { value: "..." } instead of returning
// plain strings/numbers. Some of those classes know how to serialize
// themselves back to plain text (e.g. INT64's wrapper does); others (like
// DATE) don't, and get sent to the browser as a literal object.
//
// That raw object reaching React is what causes:
//   "Uncaught Error: Minified React error #31 ... object with keys {value}"
//
// Fix: run every query result through serializeBQRows() before returning
// it from an API route. This walks the result recursively and unwraps any
// { value: ... } shaped object into its plain value, so the frontend only
// ever receives real strings/numbers/booleans/null.
//
// USAGE — in any app/api/*/route.ts:
//   import { serializeBQRows } from "@/lib/bq-serialize";
//   const rows = await bqQuery(sql);
//   return NextResponse.json(serializeBQRows(rows));
//
// Apply this to EVERY route that returns BigQuery rows, not just the one
// that's currently broken — the next DATE/NUMERIC column added to any
// query will hit the same bug otherwise.

export function serializeBQValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;

  if (Array.isArray(v)) {
    return v.map(serializeBQValue);
  }

  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);

    // BigQuery wrapper types (BigQueryDate, BigQueryDatetime,
    // BigQueryTimestamp, BigQueryTime, BigQueryNumeric, BigQueryInt, etc.)
    // are all objects whose only own key is "value".
    if (keys.length === 1 && keys[0] === "value") {
      return obj.value;
    }

    // Some wrapper types carry both "value" and internal fields — be
    // slightly more permissive and prefer "value" if present alongside
    // only internal/underscore-prefixed keys.
    if ("value" in obj && keys.every((k) => k === "value" || k.startsWith("_"))) {
      return obj.value;
    }

    // Otherwise it's a normal row object (or nested object) — recurse.
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = serializeBQValue(obj[k]);
    }
    return out;
  }

  return v;
}

export function serializeBQRows<T = Record<string, unknown>>(rows: unknown): T {
  return serializeBQValue(rows) as T;
}
