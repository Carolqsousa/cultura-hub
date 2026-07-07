"""RD Station CRM API client."""

import json
import time
import urllib.request
import urllib.error


BASE_URL = "https://crm.rdstation.com/api/v1"
TIMEOUT  = 10    # seconds before a request fails fast instead of hanging
DELAY    = 0.5   # seconds between paginated requests to avoid rate limiting


class RDStationAPIError(Exception):
    """
    Raised when a paginated fetch fails partway through, instead of
    silently returning whatever was collected so far.

    WHY THIS EXISTS: the previous version of get_all_deals()/get_all_tasks()/
    get_deal_pipelines() treated "a request failed" and "we reached the
    natural end of the data" identically -- both just stopped the loop and
    returned whatever had been collected, with no error and no warning.
    That means a network blip on page 6 of 12 would silently ship a
    half-complete dataset to BigQuery as if it were the whole picture --
    the same "silent partial failure" shape found elsewhere in this
    project (e.g. one branch's students.py upload failing while others
    succeed). Raising here instead means a failed run shows up as a loud,
    visible failure (red X in GitHub Actions) rather than a clean-looking
    run with quietly wrong, incomplete data.
    """
    pass


class RDStationClient:
    def __init__(self, token: str | None = None, label: str = ""):
        """
        Parameters
        ----------
        token : str, optional
            RD Station API token to use. If omitted, falls back to the
            RD_STATION_API_KEY environment variable -- this is the exact
            previous behavior, unchanged, so every existing caller like
            `RDStationClient()` keeps working with zero changes needed.
            Pass an explicit token to talk to a DIFFERENT RD Station
            account (e.g. Natal's separate account, which has its own
            funnels/stages/custom fields and its own deal_id numbering):
                RDStationClient(token=os.environ["RD_STATION_API_KEY_NATAL"],
                                 label="Natal")
        label : str, optional
            Short name shown in log/error messages only, so failures from
            two different accounts running in the same log stream can be
            told apart at a glance, e.g. "[RDStation:Natal] HTTP 401 on
            GET /deals" vs "[RDStation] HTTP 401 on GET /deals".
        """
        import os
        self.token = token if token is not None else os.environ.get("RD_STATION_API_KEY", "")
        self.label = f":{label}" if label else ""

    def _get(self, path: str, params: dict = None) -> dict | None:
        qs  = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        sep = "&" if qs else ""
        url = f"{BASE_URL}{path}?token={self.token}{sep}{qs}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            print(f"[RDStation{self.label}] HTTP {e.code} on GET {path}")
            return None
        except Exception as e:
            print(f"[RDStation{self.label}] Error on GET {path}: {e}")
            return None

    # ── Deals ──────────────────────────────────────────────────────────────────

    def get_all_deals(self) -> list:
        """
        Fetch all deals, paginated.

        RD Station returns deals in pages of up to 200. We keep fetching
        until has_more is False. A 0.5s delay between pages keeps us inside
        the API rate limit — without it, back-to-back requests get throttled
        and the loop hangs indefinitely.

        Raises RDStationAPIError if any page request fails (network error,
        bad token, timeout, etc.) instead of silently returning whatever
        was collected before the failure — a half-complete deal list is
        worse than no list, since nothing downstream would know it's
        incomplete.
        """
        all_deals = []
        page = 1
        while True:
            d = self._get("/deals", {"page": page, "limit": 200})
            if d is None:
                raise RDStationAPIError(
                    f"[RDStation{self.label}] get_all_deals failed on page {page} "
                    f"after collecting {len(all_deals)} deals -- aborting rather than "
                    f"returning a silently incomplete list."
                )
            deals = d.get("deals", [])
            all_deals.extend(deals)
            if not d.get("has_more"):
                break
            page += 1
            time.sleep(DELAY)
        return all_deals

    # ── Pipelines & stages ─────────────────────────────────────────────────────

    def get_deal_pipelines(self) -> list:
        """
        Fetch ALL sales funnels, each with their stages nested inside.

        GET /deal_pipelines returns a flat list (not a dict), e.g.:
          [
            {
              "id": "PIPE_A",
              "name": "Funil BOA VIAGEM",
              "deal_stages": [
                {"id": "ST1", "name": "Sala de Espera"},
                {"id": "ST2", "name": "Interesse"},
                ...
              ]
            },
            ...
          ]

        This is the correct source for building a stage->pipeline map.
        Do NOT use /deal_stages for this — without a pipeline filter it
        only returns stages from the default funnel, missing all others.
        """
        all_pipelines = []
        page  = 1
        limit = 200
        while True:
            d = self._get("/deal_pipelines", {"page": page, "limit": limit})
            if d is None:
                raise RDStationAPIError(
                    f"[RDStation{self.label}] get_deal_pipelines failed on page {page} "
                    f"after collecting {len(all_pipelines)} pipelines -- aborting rather "
                    f"than returning a silently incomplete list. A partial pipeline map "
                    f"would misassign deals to the wrong funnel with no error."
                )
            if not isinstance(d, list) or not d:
                break
            all_pipelines.extend(d)
            if len(d) < limit:
                break
            page += 1
            time.sleep(DELAY)
        return all_pipelines

    def get_deal_stages(self) -> list:
        """
        Returns stages from the DEFAULT funnel only.
        Use get_deal_pipelines() instead when you need all funnels.
        Kept here for backwards compatibility.
        """
        d = self._get("/deal_stages")
        return d.get("deal_stages", []) if d else []

    # ── Tasks ──────────────────────────────────────────────────────────────────

    def get_all_tasks(self) -> list:
        """Fetch all tasks, paginated. Raises RDStationAPIError on a failed
        page instead of silently returning a truncated list."""
        all_tasks = []
        page = 1
        while True:
            d = self._get("/tasks", {"page": page, "limit": 200})
            if d is None:
                raise RDStationAPIError(
                    f"[RDStation{self.label}] get_all_tasks failed on page {page} "
                    f"after collecting {len(all_tasks)} tasks -- aborting rather than "
                    f"returning a silently incomplete list."
                )
            tasks = d.get("tasks", [])
            all_tasks.extend(tasks)
            if not d.get("has_more"):
                break
            page += 1
            time.sleep(DELAY)
        return all_tasks

    # ── Users ──────────────────────────────────────────────────────────────────

    def get_users(self) -> list:
        d = self._get("/users")
        return d.get("users", []) if d else []
