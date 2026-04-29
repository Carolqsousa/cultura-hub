"""Sponte REST API client — one instance per branch."""

import json
import urllib.request
import urllib.error

BASE_URL = "https://webservices.sponteweb.com.br/WSApiSponteRest/api"


class SponteClient:
    def __init__(self, api_key: str, branch_name: str = "Unknown"):
        self.api_key = api_key
        self.branch_name = branch_name
        self.headers = {
            "Content-Type": "application/json",
            "api_key": api_key,
        }

    def _get(self, path: str, params: str = "") -> list | dict | None:
        url = BASE_URL + path + params
        req = urllib.request.Request(url, headers=self.headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            print(f"[SponteClient] HTTP {e.code} on GET {path}")
            return None
        except Exception as e:
            print(f"[SponteClient] Error on GET {path}: {e}")
            return None

    def _post(self, path: str, payload: dict, params: str = "") -> list | dict | None:
        url = BASE_URL + path + params
        data = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data, headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            print(f"[SponteClient] HTTP {e.code} on POST {path}")
            return None
        except Exception as e:
            print(f"[SponteClient] Error on POST {path}: {e}")
            return None

    def _list(self, raw) -> list:
        """Normalise API responses that may be a list or a dict wrapper."""
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            for key in ("data", "items", "result"):
                if isinstance(raw.get(key), list):
                    return raw[key]
        return []

    # ── Public methods called by fetchers ────────────────────────────────────

    def get_students(self) -> list:
        return self._list(self._get("/students"))

    def get_financials(self) -> list:
        return self._list(self._get("/financials"))

    def get_attendance(self) -> list:
        return self._list(self._get("/attendance"))

    def get_grades(self) -> list:
        return self._list(self._get("/grades"))

    def get_cancellations(self) -> list:
        return self._list(self._get("/cancellations"))
