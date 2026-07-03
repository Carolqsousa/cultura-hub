"""
pipeline/run_leads.py
Orchestrator — called by GitHub Actions daily.

Responsibilities:
  1. Create the RD Station client (one instance, shared across pipelines)
  2. Build the pipeline map ONCE (shared between leads and tasks)
  3. Ensure BigQuery tables exist
  4. Fetch and write leads
  5. Fetch and write tasks
  6. Fail loudly if anything goes wrong

Why this file exists separately from leads.py and tasks.py?
Single responsibility principle. Each file does one job:
  - rd_station_client.py  →  speaks to the RD Station API
  - leads.py              →  shapes deal data into rows
  - tasks.py              →  shapes task data into rows
  - bigquery/client.py    →  speaks to BigQuery
  - run_leads.py          →  orchestrates all of the above

This separation makes each piece independently testable and replaceable.
If RD Station changes their API, you update rd_station_client.py only.
If BigQuery changes their SDK, you update bigquery/client.py only.
The orchestrator stays the same.
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
    rd      = RDStationClient()
    failed  = []

    # ── Step 1: build shared pipeline map ────────────────────────────────────
    # This is the only call to /deal_pipelines in the entire run.
    # Both leads and tasks receive these maps as parameters.
    try:
        stage_pipeline_map, stage_pname_map = build_pipeline_maps(rd)
    except Exception:
        log.exception("Failed to build pipeline map — aborting entire run")
        sys.exit(1)

    # ── Step 2: leads pipeline ────────────────────────────────────────────────
    try:
        ensure_table("leads")
        rows = fetch_leads(rd, stage_pipeline_map, stage_pname_map)
        upsert_rows("leads", rows)
        log.info(f"leads: {len(rows)} rows written")
    except Exception:
        log.exception("leads pipeline FAILED")
        failed.append("leads")

    # ── Step 3: tasks pipeline ────────────────────────────────────────────────
    try:
        ensure_table("tasks")
        rows = fetch_tasks(rd, stage_pipeline_map, stage_pname_map)
        upsert_rows("tasks", rows)
        log.info(f"tasks: {len(rows)} rows written")
    except Exception:
        log.exception("tasks pipeline FAILED")
        failed.append("tasks")

    # ── Step 4: exit loudly if anything failed ────────────────────────────────
    # sys.exit(1) makes GitHub Actions mark the job as FAILED,
    # which triggers an email notification to the repo owner.
    # Without this, a failed pipeline shows as green — silent data loss.
    if failed:
        log.error(f"The following pipelines failed: {failed}")
        sys.exit(1)

    log.info("All pipelines completed successfully")


if __name__ == "__main__":
    run()
