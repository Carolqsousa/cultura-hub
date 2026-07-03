"""
pipeline/rd_station/leads.py
Fetches deals + late tasks from RD Station CRM with full field mapping.
"""

import os
from datetime import date, datetime


def _custom_field(deal, label):
    """Extract a custom field value by label name."""
    for cf in deal.get("deal_custom_fields", []):
        if (cf.get("custom_field") or {}).get("label", "").strip().lower() == label.lower():
            return cf.get("value")
    return None

def _bool_field(val):
    if val is None: return None
    if isinstance(val, bool): return val
    return str(val).strip().lower() in ("sim", "yes", "true", "1")

def _int_field(val):
    try:
        return int(str(val).replace("+", "").strip())
    except Exception:
        return None

def _parse_date(raw):
    if not raw: return None
    return str(raw)[:10]

def _tmv(created, closed):
    try:
        c = date.fromisoformat(str(created)[:10])
        f = date.fromisoformat(str(closed)[:10])
        return max(0, (f - c).days)
    except Exception:
        return None


def fetch(rd_client) -> list[dict]:
    today    = date.today().isoformat()
    today_dt = date.today()

    print(f"  [leads] Fetching all deals...")
    deals     = rd_client.get_all_deals()
    pipelines = rd_client.get_deal_pipelines()

    # Build stage->name and stage->pipeline_id maps from /deal_pipelines.
    # This single call covers ALL funnels; /deal_stages alone only returns the default one.
    stage_map          = {}  # stage_id -> stage name
    stage_pipeline_map = {}  # stage_id -> pipeline_id
    for p in pipelines:
        pid = p.get("id", "")
        for s in p.get("deal_stages", []):
            sid = s.get("id")
            if sid:
                stage_map[sid]          = s.get("name", "")
                stage_pipeline_map[sid] = pid

    print(f"  [leads] {len(deals)} deals, {len(pipelines)} pipelines")
    rows = []

    for d in deals:
        stage_id    = (d.get("deal_stage") or {}).get("id", "")
        pipeline_id = stage_pipeline_map.get(stage_id, "")
        user     = d.get("user") or {}
        source   = (d.get("deal_source") or {}).get("name", "")
        campaign = (d.get("campaign") or {}).get("name", "")
        loss_raw = d.get("deal_lost_reason") or {}
        loss_reason = loss_raw.get("name", "") if isinstance(loss_raw, dict) else str(loss_raw)

        # status
        if d.get("win") is True:
            status = "won"
        elif d.get("win") is False:
            status = "lost"
        elif d.get("hold"):
            status = "paused"
        else:
            status = "open"

        created = _parse_date(d.get("created_at"))
        closed  = _parse_date(d.get("closed_at"))
        tmv     = _tmv(created, closed) if status == "won" else None

        rows.append({
            "date":              today,
            "record_type":       "deal",
            "deal_id":           d.get("id", ""),
            "name":              d.get("name", ""),
            "pipeline_id":       pipeline_id,
            "stage":             (d.get("deal_stage") or {}).get("name") or stage_map.get(stage_id, ""),
            "status":            status,
            "responsible":       user.get("name", ""),
            "responsible_id":    user.get("id", ""),
            "source":            source or "Desconhecido",
            "campaign":          campaign or "",
            "loss_reason":       loss_reason or "",
            "temperature":       _custom_field(d, "Temperatura do Lead") or "",
            "unit_interest":     _custom_field(d, "Unidade de Interesse") or "",
            "semester_interest": _custom_field(d, "Semestre de Interesse") or "",
            "tipo":              _custom_field(d, "Tipo") or "",
            "scheduled":         _bool_field(_custom_field(d, "Agendamento")),
            "attended":          _bool_field(_custom_field(d, "Comparecimento")),
            "contact_attempts":  _int_field(_custom_field(d, "Tentativa de Contato")),
            "contact_returns":   _int_field(_custom_field(d, "Retorno de Contato")),
            "created_at":        created,
            "closed_at":         closed,
            "rating":            d.get("rating"),
            "interactions":      d.get("interactions", 0),
            "tmv_days":          tmv,
            "task_subject":      None,
            "task_done":         None,
            "task_due_date":     None,
            "days_late":         None,
            "run_date":          today,
        })

    print(f"  [leads] Fetching all tasks...")
    tasks = rd_client.get_all_tasks()
    late_count = 0

    for t in tasks:
        if t.get("done"):
            continue
        task_date = _parse_date(t.get("date"))
        if not task_date or task_date >= today:
            continue

        days_late = (today_dt - date.fromisoformat(task_date)).days
        users     = t.get("users") or []
        user_name = users[0].get("name", "") if users else ""
        user_id   = users[0].get("id", "")   if users else ""
        deal          = t.get("deal") or {}
        task_stage_id = (deal.get("deal_stage") or {}).get("id", "")
        task_pipeline = stage_pipeline_map.get(task_stage_id, "")

        rows.append({
            "date":              today,
            "record_type":       "late_task",
            "deal_id":           t.get("deal_id", ""),
            "name":              deal.get("name", ""),
            "pipeline_id":       task_pipeline,
            "stage":             None,
            "status":            "late",
            "responsible":       user_name,
            "responsible_id":    user_id,
            "source":            None,
            "campaign":          None,
            "loss_reason":       None,
            "temperature":       None,
            "unit_interest":     None,
            "semester_interest": None,
            "tipo":              None,
            "scheduled":         None,
            "attended":          None,
            "contact_attempts":  None,
            "contact_returns":   None,
            "created_at":        _parse_date(t.get("created_at")),
            "closed_at":         None,
            "rating":            None,
            "interactions":      None,
            "tmv_days":          None,
            "task_subject":      t.get("subject", ""),
            "task_done":         t.get("done", False),
            "task_due_date":     task_date,
            "days_late":         days_late,
            "run_date":          today,
        })
        late_count += 1

    print(f"  [leads] {late_count} late tasks, {len(rows)} total rows")
    return rows
