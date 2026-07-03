"""
pipeline/run_leads.py
Orchestrator — called by GitHub Actions daily.

Responsibilities:
  1. Create the RD Station client (one instance, shared across pipelines)
  2. Build the pipeline map ONCE from /deal_pipelines (shared between leads and tasks)
  3. Fetch and write leads — capturing a deal_id->pipeline_name map as a by-product
  4. Build deal map from leads rows (zero extra API calls)
  5. Fetch and write tasks — using deal map to resolve pipeline_name
  6. Fail loudly if anything goes wrong

Why this file exists separately from leads.py and tasks.py?
Single responsibility principle. Each file does one job:
  - rd_station_client.py  ->  speaks to the RD Station API
  - leads.py              ->  shapes deal data into rows
  - tasks.py              ->  shapes task data into rows
  - bigquery/client.py    ->  speaks to BigQuery
  - run_leads.py          ->  orchestrates all of the above

Why does run_leads.py build and share the deal map?
The /tasks API endpoint returns a minimal deal snapshot per task — just
name, id, hold, and rating. It does NOT include deal_stage, which means
tasks.py can't resolve pipeline_name from the stage map alone.

The solution: after fetch_leads() runs, we build a deal_id->pipeline_name
map from the rows it already produced. This map is then passed to
fetch_tasks() so every task can resolve its pipeline_name via its deal_id.
Zero extra API calls — we reuse data already fetched.
"""

import logging
import sys

from bigquery.client import ensure_table, upsert_rows
from rd_station_client import RDStationClient
from rd_station.leads import fetch as fetch_leads
from rd_station.tasks import fetch as fetch_tasks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)


def build_pipeline_maps(rd_client):
    """
    Fetch all funnels from RD Station and return two lookup maps.

    Returns
    -------
    stage_pipeline_map : dict
        stage_id -> pipeline_id (opaque MongoDB ID, useful for joins)

    stage_pname_map : dict
        stage_id -> pipeline_name (human-readable, useful for display)

    Why build this here instead of inside leads.py or tasks.py?
    Both pipelines need the same maps. Building them once in the
    orchestrator and passing them down means:
      - One API call instead of two
      - Guaranteed consistency — both tables use identical mapping
      - Clear ownership — the orchestrator manages shared resources,
        workers (leads.py, tasks.py) only shape data into rows
    """
    log.info("Building pipeline map from /deal_pipelines...")
    pipelines = rd_client.get_deal_pipelines()

    stage_pipeline_map = {}
    stage_pname_map    = {}

    for p in pipelines:
        pid   = p.get("id", "")
        pname = p.get("name", "")
        for s in p.get("deal_stages", []):
            sid = s.get("id")
            if sid:
                stage_pipeline_map[sid] = pid
                stage_pname_map[sid]    = pname

    n_stages = len(stage_pipeline_map)
    log.info(f"Pipeline map ready: {len(pipelines)} funnels, {n_stages} stages")

    return stage_pipeline_map, stage_pname_map


def run():
    """
    Main pipeline execution. Called once per GitHub Actions run.

    Error handling strategy:
    Each pipeline (leads, tasks) is wrapped in its own try/except so
    a failure in one doesn't prevent the other from running. For example,
    if the /tasks endpoint returns a 400, we still want leads to write
    successfully. Each failure is logged clearly.

    At the end, if ANY pipeline failed, we exit with code 1. This makes
    GitHub Actions mark the job as FAILED and send you an email — so you
    know immediately when something broke, rather than discovering it
    hours later when you check the data manually.

    Why is loud failure important?
    Silent failures are the most dangerous class of bug in data systems.
    The pipeline appears to run (GitHub Actions shows green), rows are
    written, the table keeps growing — but the data is wrong or incomplete.
    You only discover this when a manager asks why the numbers look off.
    Loud failures (red job, email notification) surface problems immediately
    when they're cheapest to fix.
    """
    rd     = RDStationClient()
    failed = []

    # ── Step 1: build shared pipeline map ────────────────────────────────────
    # This is the only call to /deal_pipelines in the entire run.
    # Both leads and tasks receive these maps as parameters.
    try:
        stage_pipeline_map, stage_pname_map = build_pipeline_maps(rd)
    except Exception:
        log.exception("Failed to build pipeline map — aborting entire run")
        sys.exit(1)

    # ── Step 2: leads pipeline ────────────────────────────────────────────────
    # We also build a deal_id->pipeline_name map from the rows produced here.
    # This map is passed to fetch_tasks() so tasks can resolve pipeline_name
    # via their deal_id — because the /tasks API doesn't include stage info.
    deal_pipeline_map = {}
    try:
        ensure_table("leads")
        lead_rows = fetch_leads(rd, stage_pipeline_map, stage_pname_map)
        upsert_rows("leads", lead_rows)
        log.info(f"leads: {len(lead_rows)} rows written")

        # Build deal_id -> pipeline_name from the leads rows we just produced.
        # Only include deals that have a resolved pipeline_name — deals without
        # one (orphaned stages) can't help tasks either.
        deal_pipeline_map = {
            r["deal_id"]: r["pipeline_name"]
            for r in lead_rows
            if r.get("deal_id") and r.get("pipeline_name")
        }
        log.info(f"Deal pipeline map: {len(deal_pipeline_map)} deals with pipeline")
    except Exception:
        log.exception("leads pipeline FAILED")
        failed.append("leads")

    # ── Step 3: tasks pipeline ────────────────────────────────────────────────
    # deal_pipeline_map may be empty if leads failed — tasks will still run
    # but pipeline_name will be empty. This is acceptable: tasks running with
    # partial data is better than tasks not running at all.
    try:
        ensure_table("tasks")
        task_rows = fetch_tasks(rd, stage_pipeline_map, stage_pname_map, deal_pipeline_map)
        upsert_rows("tasks", task_rows)
        log.info(f"tasks: {len(task_rows)} rows written")
    except Exception:
        log.exception("tasks pipeline FAILED")
        failed.append("tasks")

    # ── Step 4: exit loudly if anything failed ────────────────────────────────
    if failed:
        log.error(f"The following pipelines failed: {failed}")
        sys.exit(1)

    log.info("All pipelines completed successfully")


if __name__ == "__main__":
    run()
