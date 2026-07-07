"""
pipeline/run_leads_natal.py
Orchestrator for Natal's RD Station account — GitHub Actions daily.

WHY THIS IS A SEPARATE FILE, NOT A PARAMETER ON run_leads.py:
Natal uses a COMPLETELY SEPARATE RD Station account -- its own API key,
its own funnels, its own deal_id numbering. Deal IDs are only unique
WITHIN one RD Station account: Natal's deal #4821 and the main account's
deal #4821 are almost certainly two unrelated leads that happen to share
a number. Writing both into the same `leads` table, deduplicated by
deal_id, would risk one silently overwriting the other. That's why this
writes to a SEPARATE table, `leads_natal` -- its own dedup namespace,
nothing can collide with the main account no matter how IDs number.

WHY THIS REUSES leads.py UNCHANGED, INSTEAD OF DUPLICATING IT:
fetch(rd_client, stage_pipeline_map, stage_pname_map) in rd_station/leads.py
never hardcodes which RD Station account it's talking to -- it just uses
whatever rd_client it's given. Copy-pasting that ~140 lines of field-
mapping logic into a second file would recreate the exact failure mode
already hit once in this project: two files independently encoding the
same business logic, silently drifting apart the next time RD Station
changes a field. Reusing the same function means a fix or a new field
mapping only ever needs to happen in one place, for both accounts at once.

WHAT'S DELIBERATELY LEFT OUT (for now):
Tasks (late-task tracking) are NOT fetched here -- only deals. The
original ask was specifically about funnel data for a second commercial
page. If Natal needs late-task tracking later, add it the same way
run_leads.py does: build a deal_id -> pipeline_name map from the leads
rows just written, pass it to tasks.py's fetch(), write to a new
`tasks_natal` table (same "separate table" reasoning as leads_natal).

CONFIGURATION:
Requires the RD_STATION_API_KEY_NATAL secret (separate from
RD_STATION_API_KEY, which stays pointed at the main account).
Deliberately does NOT read or set SPONTE_BRANCH_CURRENT -- leads_natal
has no `branch` column, same as `leads`. See client.py's upsert_rows()
for why that distinction matters: if this env var were ever set in this
run's environment, upsert_rows would try to filter a DELETE by a `branch`
column leads_natal doesn't have.
"""

import logging
import os
import sys

from bigquery.client import ensure_table, upsert_rows
from rd_station_client import RDStationClient
from rd_station.leads import fetch as fetch_leads

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger(__name__)

TABLE_NAME = "leads_natal"


def build_pipeline_maps(rd_client):
    """
    Same logic as run_leads.py's build_pipeline_maps(), duplicated here
    rather than imported, because it's ~15 lines with no shared state risk
    (unlike leads.py's fetch(), which is genuinely the same business logic
    for both accounts, this is just "call an API and build a dict" -- low
    enough risk that a shared import isn't worth the extra coupling).
    """
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
    Main pipeline execution for Natal's RD Station leads.

    Error handling strategy, same as run_leads.py: fail loudly. If the
    API key is missing/wrong, or the pagination fetch fails partway
    (raises RDStationAPIError, per today's fix), or the BigQuery write
    fails, this exits non-zero -- GitHub Actions shows red, not a
    clean-looking run with silently missing or incomplete data.
    """
    api_key = os.environ.get("RD_STATION_API_KEY_NATAL", "")
    if not api_key:
        log.error("RD_STATION_API_KEY_NATAL is not set -- aborting rather than "
                   "running with an empty token, which would silently return zero deals "
                   "and look identical to 'Natal genuinely has no leads today'.")
        sys.exit(1)

    rd = RDStationClient(token=api_key, label="Natal")

    try:
        stage_pipeline_map, stage_pname_map = build_pipeline_maps(rd)
    except Exception:
        log.exception("Failed to build Natal pipeline map — aborting entire run")
        sys.exit(1)

    try:
        ensure_table(TABLE_NAME)
        lead_rows = fetch_leads(rd, stage_pipeline_map, stage_pname_map)
        upsert_rows(TABLE_NAME, lead_rows)  # no branch= arg: leads_natal has no branch column
        log.info(f"{TABLE_NAME}: {len(lead_rows)} rows written")
    except Exception:
        log.exception(f"{TABLE_NAME} pipeline FAILED")
        sys.exit(1)

    log.info("Natal leads pipeline completed successfully")


if __name__ == "__main__":
    run()
