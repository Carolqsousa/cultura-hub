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

    def get_active_classes(self, semester: str) -> list:
        """Returns open classes for the given semester."""
        classes = self._list(self._get("/classes"))
        return [
            c for c in classes
            if c.get("situation") == 1 and semester in (c.get("name") or "")
        ]

    def get_class_detail(self, class_id: int) -> dict:
        """Returns full class detail including members list."""
        result = self._post("/classes", {"class_id": class_id})
        return result if isinstance(result, dict) else {}

    def get_active_student_ids(self, semester: str) -> set:
        """Returns unique student IDs enrolled in open classes this semester."""
        student_ids = set()
        classes = self.get_active_classes(semester)
        for cls in classes:
            detail = self.get_class_detail(cls.get("class_id"))
            for m in detail.get("members", []):
                sid = m.get("student_id")
                if sid:
                    student_ids.add(sid)
        return student_ids

    def get_receivables(self, student_id: int) -> list:
        """Returns all pending receivables for a student (paginates automatically)."""
        all_rows = []
        page = 1
        while True:
            data = self._post("/receivables", {
                "student_id":  student_id,
                "page_number": page
            })
            if not isinstance(data, list) or not data:
                break
            if "Nenhum registro" in str(data[0]):
                break
            if isinstance(data[0], dict) and data[0].get("error"):
                break
            pending = [p for p in data if p.get("status") == 0]
            all_rows.extend(pending)
            if len(data) < 20:
                break
            page += 1
        return all_rows

    def get_financials(self) -> list:
        # Legacy — kept for compatibility, use get_receivables() instead
        return []

    def get_attendance(self) -> list:
        return self._list(self._get("/attendance"))

    def get_grades(self) -> list:
        return self._list(self._get("/grades"))

    def get_cancellations(self) -> list:
        return self._list(self._get("/cancellations"))
