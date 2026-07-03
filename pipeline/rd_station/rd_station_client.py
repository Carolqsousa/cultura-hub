"""RD Station CRM API client."""

import json
import time
import urllib.request
import urllib.error


BASE_URL = "https://crm.rdstation.com/api/v1"
TIMEOUT  = 10    # seconds before a request fails fast instead of hanging
DELAY    = 0.5   # seconds between paginated requests to avoid rate limiting


class RDStationClient:
    def __init__(self):
        import os
        self.token = os.environ.get("RD_STATION_API_KEY", "")

    def _get(self, path: str, params: dict = None) -> dict | None:
        qs  = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        sep = "&" if qs else ""
        url = f"{BASE_URL}{path}?token={self.token}{sep}{qs}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            print(f"[RDStation] HTTP {e.code} on GET {path}")
            return None
        except Exception as e:
            print(f"[RDStation] Error on GET {path}: {e}")
            return None

    # ── Deals ──────────────────────────────────────────────────────────────────

    def get_all_deals(self) -> list:
        """
        Fetch all deals, paginated.

        RD Station returns deals in pages of up to 200. We keep fetching
        until has_more is False. A 0.5s delay between pages keeps us inside
        the API rate limit — without it, back-to-back requests get throttled
        and the loop hangs indefinitely.
        """
        all_deals = []
        page = 1
        while True:
            d = self._get("/deals", {"page": page, "limit": 200})
            if not d:
                break
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
        """Fetch all tasks, paginated."""
        all_tasks = []
        page = 1
        while True:
            d = self._get("/tasks", {"page": page, "limit": 200})
            if not d:
                break
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
