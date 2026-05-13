"""RD Station CRM API client."""

import json
import urllib.request
import urllib.error


BASE_URL = "https://crm.rdstation.com/api/v1"


class RDStationClient:
    def __init__(self):
        import os
        self.token = os.environ.get("RD_STATION_API_KEY", "")

    def _get(self, path: str, params: dict = None) -> dict | None:
        qs = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        sep = "&" if qs else ""
        url = f"{BASE_URL}{path}?token={self.token}{sep}{qs}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            print(f"[RDStation] HTTP {e.code} on GET {path}")
            return None
        except Exception as e:
            print(f"[RDStation] Error on GET {path}: {e}")
            return None

    def get_all_deals(self) -> list:
        """Fetch all deals paginated."""
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
        return all_deals

    def get_deal_stages(self) -> list:
        d = self._get("/deal_stages")
        return d.get("deal_stages", []) if d else []

    def get_all_tasks(self) -> list:
        """Fetch all tasks paginated."""
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
        return all_tasks

    def get_users(self) -> list:
        d = self._get("/users")
        return d.get("users", []) if d else []
