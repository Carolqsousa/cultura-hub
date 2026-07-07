"""
pipeline/run_leads_natal.py
Orchestrator for Natal's RD Station account — GitHub Actions daily.

WHY THIS IS A SEPARATE FILE, NOT A PARAMETER ON run_leads.py:
Natal uses a COMPLETELY SEPARATE RD Station account -- its own API key,
its own funnels, its own deal_id numbering. Deal IDs are only unique
WITHIN one RD Station account: Natal's deal #4821 and the main account's
deal #4821 are almost certainly two unrelated leads that happen to share
a number. Writing both into the same `leads`/`tasks` tables, deduplicated
by deal_id, would risk one silently overwriting the other. That's why
this writes to SEPARATE tables, `leads_natal`/`tasks_natal` -- their own
dedup namespace, nothing can collide with the main account.

WHY THIS REUSES leads.py/tasks.py UNCHANGED, INSTEAD OF DUPLICATING THEM:
Both fetch() functions never hardcode which RD Station account they're
talking to -- they just use whatever rd_client/maps they're given.
Copy-pasting that logic into new files would recreate the exact failure
mode already hit once in this project: two files independently encoding
the same business logic, silently drifting apart the next time RD
Station changes a field.

NOW INCLUDES TASKS (late-task tracking), added after the initial
deals-only build -- mirrors run_leads.py's exact pattern: fetch leads
first, build a deal_id -> pipeline_name map from the rows just written
(zero extra API calls), pass that to fetch_tasks().

CONFIGURATION:
Requires the RD_STATION_API_KEY_NATAL secret. Deliberately does NOT read
or set SPONTE_BRANCH_CURRENT -- neither leads_natal nor tasks_natal has a
`branch` column, same as the main leads/tasks tables.
"""

import logging
import os
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

LEADS_TABLE = "leads_natal"
TASKS_TABLE = "tasks_natal"


def build_pipeline_maps(rd_client):
    """Same logic as run_leads.py's build_pipeline_maps() -- see that
    file's docstring for why it's duplicated here rather than imported
    (low-risk, ~15 lines, not worth the extra coupling)."""
    log.info("Building pipeline map from Natal's /deal_pipelines...")
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
    log.info(f"Natal pipeline map ready: {len(pipelines)} funnels, {n_stages} stages")

    return stage_pipeline_map, stage_pname_map


def run():
    """
    Main pipeline execution for Natal's RD Station leads + tasks.

    Error handling strategy, same as run_leads.py: each pipeline (leads,
    tasks) has its own try/except so a failure in one doesn't block the
    other, but the run exits non-zero if EITHER failed -- GitHub Actions
    shows red, you find out immediately instead of discovering it later
    when the numbers look off.
    """
    api_key = os.environ.get("RD_STATION_API_KEY_NATAL", "")
    if not api_key:
        log.error("RD_STATION_API_KEY_NATAL is not set -- aborting rather than "
                   "running with an empty token, which would silently return zero "
                   "deals and look identical to 'Natal genuinely has no leads today'.")
        sys.exit(1)

    rd     = RDStationClient(token=api_key, label="Natal")
    failed = []

    try:
        stage_pipeline_map, stage_pname_map = build_pipeline_maps(rd)
    except Exception:
        log.exception("Failed to build Natal pipeline map — aborting entire run")
        sys.exit(1)

    # ── Leads ──────────────────────────────────────────────────────────────
    deal_pipeline_map = {}
    try:
        ensure_table(LEADS_TABLE)
        lead_rows = fetch_leads(rd, stage_pipeline_map, stage_pname_map)
        upsert_rows(LEADS_TABLE, lead_rows)  # no branch=: leads_natal has no branch column
        log.info(f"{LEADS_TABLE}: {len(lead_rows)} rows written")

        deal_pipeline_map = {
            r["deal_id"]: r["pipeline_name"]
            for r in lead_rows
            if r.get("deal_id") and r.get("pipeline_name")
        }
        log.info(f"Natal deal pipeline map: {len(deal_pipeline_map)} deals with pipeline")
    except Exception:
        log.exception(f"{LEADS_TABLE} pipeline FAILED")
        failed.append(LEADS_TABLE)

    # ── Tasks ──────────────────────────────────────────────────────────────
    # deal_pipeline_map may be empty if leads failed -- tasks still runs,
    # pipeline_name just comes back blank for those rows. Same accepted
    # tradeoff as run_leads.py: tasks with partial data beats no tasks.
    try:
        ensure_table(TASKS_TABLE)
        task_rows = fetch_tasks(rd, stage_pipeline_map, stage_pname_map, deal_pipeline_map)
        upsert_rows(TASKS_TABLE, task_rows)  # no branch=: tasks_natal has no branch column
        log.info(f"{TASKS_TABLE}: {len(task_rows)} rows written")
    except Exception:
        log.exception(f"{TASKS_TABLE} pipeline FAILED")
        failed.append(TASKS_TABLE)

    if failed:
        log.error(f"The following Natal pipelines failed: {failed}")
        sys.exit(1)

    log.info("All Natal pipelines completed successfully")


if __name__ == "__main__":
    run()
