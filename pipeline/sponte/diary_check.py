"""
pipeline/sponte/diary_checks.py

Fetches diary completion data from Sponte and returns rows
ready to be inserted into BigQuery `diary_checks` table.

Called by pipeline/main.py — does NOT prompt for input.
All config comes from environment variables.
"""

import os
import urllib.request
import urllib.error
import json
from datetime import datetime, date

BASE_URL = "https://webservices.sponteweb.com.br/WSApiSponteRest/api"

# ─── These come from environment variables (GitHub Secrets) ──────────────────
# SPONTE_API_KEY   — API key for the branch
# SPONTE_BRANCH    — branch name e.g. "Boa Viagem"
# SPONTE_SEMESTER  — e.g. "2026.1"
# SPONTE_START     — e.g. "2026-02-01"
# SPONTE_END       — e.g. "2026-12-31"
# ─────────────────────────────────────────────────────────────────────────────

def get_config(api_key: str, branch: str):
    return {
        "api_key":    api_key,
        "branch":     branch,
        "semester":   os.environ.get("SPONTE_SEMESTER", "2026.1"),
        "start_date": os.environ.get("SPONTE_START", "2026-02-01"),
        "end_date":   os.environ.get("SPONTE_END", "2026-12-31"),
    }

def make_headers(api_key):
    return {"Content-Type": "application/json", "api_key": api_key}

def req(path, headers, payload=None, params=""):
    url = BASE_URL + path + params
    data = json.dumps(payload).encode() if payload is not None else None
    method = "POST" if payload is not None else "GET"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=20) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  [diary_checks] HTTP {e.code} em {path}")
        return None
    except Exception as e:
        print(f"  [diary_checks] Erro em {path}: {e}")
        return None

def parse_date(raw):
    raw = (raw or "")[:10]
    try:
        if "-" in raw: return date.fromisoformat(raw)
        if "/" in raw: return datetime.strptime(raw, "%d/%m/%Y").date()
    except Exception:
        pass
    return None

def get_classes(headers):
    d = req("/classes", headers)
    if isinstance(d, list): return d
    if isinstance(d, dict): return d.get("classes") or d.get("data") or []
    return []

def get_class_detail(class_id, headers):
    return req("/classes", headers, {"class_id": class_id}) or {}

def get_lessons(class_id, student_id, situation, headers, start, end):
    params = f"?start_date={start}&end_date={end}"
    d = req("/lessons", headers,
            {"class_id": class_id, "student_id": student_id, "situation": situation},
            params)
    if isinstance(d, list):
        return [l for l in d if "response" not in l]
    return []

def fetch(client):
    """
    Main entry point called by pipeline/main.py.
    Returns a list of dicts ready for BigQuery insertion.

    BigQuery schema (diary_checks):
        date          DATE
        branch        STRING
        class_id      INTEGER
        class_name    STRING
        professor     STRING
        semester      STRING
        total_lessons INTEGER
        completed     INTEGER
        pending       INTEGER
        pct_complete  FLOAT
        last_completed_date DATE
        run_date      DATE      (partition column)
    """
    cfg     = get_config(api_key=client.api_key, branch=getattr(client, "branch_name", "Unknown"))
    headers = make_headers(cfg["api_key"])
    # Note: client is passed in but config still comes from env vars
    # This keeps consistency with the pipeline pattern
    today   = date.today()

    print(f"[diary_checks] Branch: {cfg['branch']} | {today}")

    classes = get_classes(headers)
    active  = [c for c in classes
               if c.get("situation") == 1
               and cfg["semester"] in (c.get("name") or "")]

    print(f"[diary_checks] {len(active)} turmas ativas para '{cfg['semester']}'")

    rows = []
    for i, cls in enumerate(active):
        cid  = cls.get("class_id") or cls.get("id")
        name = cls.get("name", f"Turma {cid}")
        print(f"  [{i+1}/{len(active)}] {name}...", end=" ", flush=True)

        detail  = get_class_detail(cid, headers)
        prof    = detail.get("professor_name", "")
        members = detail.get("members", [])

        # use oldest student — sees the most lesson history
        def parse_start(m):
            try: return date.fromisoformat((m.get("start_date") or "")[:10])
            except: return date.max

        members_sorted = sorted(members, key=parse_start)
        sid = members_sorted[0]["student_id"] if members_sorted else None

        if not sid:
            print("sem alunos, pulando")
            continue

        # confirmed lessons up to today (situation=1)
        done = [l for l in get_lessons(cid, sid, 1, headers, cfg["start_date"], cfg["end_date"])
                if parse_date(l.get("class_date")) and parse_date(l.get("class_date")) < today]

        # cancelled lessons up to today (situation=2) — count as done, no diary needed
        cancelled = [l for l in get_lessons(cid, sid, 2, headers, cfg["start_date"], cfg["end_date"])
                     if parse_date(l.get("class_date")) and parse_date(l.get("class_date")) < today]

        done = done + cancelled

        # scheduled but not confirmed up to today (situation=0) = pending
        pending = [l for l in get_lessons(cid, sid, 0, headers, cfg["start_date"], cfg["end_date"])
                   if parse_date(l.get("class_date")) and parse_date(l.get("class_date")) < today]

        total     = len(done) + len(pending)
        completed = len(done)
        pend      = len(pending)
        pct       = round(completed / total * 100, 1) if total > 0 else 100.0

        done_dates = [parse_date(l.get("class_date")) for l in done]
        last_done  = max(done_dates).isoformat() if done_dates else None

        print(f"{total} aulas | {completed} OK | {pend} pendentes | {pct}%")

        rows.append({
            "date":                 today.isoformat(),
            "branch":               cfg["branch"],
            "class_id":             cid,
            "class_name":           name,
            "professor":            prof,
            "semester":             cfg["semester"],
            "total_lessons":        total,
            "completed":            completed,
            "pending":              pend,
            "pct_complete":         pct,
            "last_completed_date":  last_done,
            "run_date":             today.isoformat(),
        })

    print(f"[diary_checks] Done — {len(rows)} turmas, "
          f"{sum(r['pending'] for r in rows)} pendentes total")
    return rows


if __name__ == "__main__":
    # quick local test — prints rows without writing to BigQuery
    import pprint
    rows = fetch()
    print(f"\n{len(rows)} rows ready for BigQuery:")
    pprint.pprint(rows[:2])
