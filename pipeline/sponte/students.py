import os
import time
from datetime import date


def fetch(sponte_client) -> list[dict]:
    """
    Returns active students from open classes this semester.
    Gets student list from class members, enriches with POST /students.
    """
    today    = date.today().isoformat()
    branch   = os.environ.get("SPONTE_BRANCH_CURRENT", "")
    semester = os.environ.get("SPONTE_SEMESTER", "2026.1")

    # get unique student IDs from open classes
    print(f"  [students] Collecting active student IDs for {branch}...")
    student_ids = sponte_client.get_active_student_ids(semester)
    print(f"  [students] {len(student_ids)} unique students in open classes")

    rows = []
    for i, student_id in enumerate(student_ids):
        raw = sponte_client._post("/students", {"student_id": student_id})

        # API can return list or dict
        if isinstance(raw, list):
            raw = raw[0] if raw else {}
        if not raw or not isinstance(raw, dict):
            continue

        # get situation description
        situation = raw.get("situation") or {}
        if isinstance(situation, dict):
            status = situation.get("description", "")
        else:
            status = str(situation)

        # get monthly value from registrations
        monthly_value = None
        discount_percent = None
        registrations = raw.get("registrations") or []
        if registrations:
            reg = registrations[-1]  # most recent
            monthly_value    = _safe_float(reg.get("monthly_value") or reg.get("value"))
            discount_percent = _safe_float(reg.get("discount_percent") or reg.get("discount"))

        rows.append({
            "date":             today,
            "branch":           branch,
            "student_id":       str(student_id),
            "name":             raw.get("name") or raw.get("student_name") or "",
            "status":           status,
            "discount_percent": discount_percent,
            "monthly_value":    monthly_value,
            "class_id":         None,
            "teacher":          None,
        })

        time.sleep(0.05)

        if i % 50 == 0 and i > 0:
            print(f"  [students] {i}/{len(student_ids)} students processed")

    print(f"  [students] Done — {len(rows)} students for {branch}")
    return rows


def _safe_float(val):
    try:
        return float(str(val).replace(",", "."))
    except Exception:
        return None
