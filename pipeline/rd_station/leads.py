"""
pipeline/rd_station/leads.py
Fetches deals from RD Station CRM with full field mapping.

Each daily run produces one row per deal, capturing its current state.
History is preserved by keeping all past runs in BigQuery (append pattern).
"""

from datetime import date


def _custom_field(deal, label):
    """
    Extract a custom field value by matching its label name.

    Custom fields in RD Station are stored as an array on each deal:
      deal_custom_fields: [
        { custom_field: { label: "Tipo" }, value: "Novato" },
        { custom_field: { label: "Temperatura do Lead" }, value: "Quente" },
        ...
      ]

    We match by label because that's what's human-readable and stable
    day-to-day. The risk: if someone renames the field in RD Station,
    this silently returns None. A more robust approach would match by
    custom_field_id (the immutable MongoDB ID), but that requires storing
    the IDs separately. Label matching is the practical choice for now.
    """
    for cf in deal.get("deal_custom_fields", []):
        if (cf.get("custom_field") or {}).get("label", "").strip().lower() == label.lower():
            return cf.get("value")
    return None


def _bool_field(val):
    """Convert RD Station option values ('Sim'/'Não') to Python booleans."""
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("sim", "yes", "true", "1")


def _int_field(val):
    """Safely convert a value to int, returning None on failure."""
    try:
        return int(str(val).replace("+", "").strip())
    except Exception:
        return None


def _parse_date(raw):
    """
    Extract just the date portion from a datetime string.
    RD Station returns ISO datetimes like '2026-07-02T18:13:34.275-03:00'.
    We keep only the date '2026-07-02' — time and timezone aren't needed
    for the analyses this table supports.
    """
    if not raw:
        return None
    return str(raw)[:10]


def _tmv(created, closed):
    """
    Calculate Time to Win in days (TMV = Tempo Médio de Venda).
    Only meaningful for won deals where both dates are present.
    Returns 0 if closed on the same day it was created.
    """
    try:
        c = date.fromisoformat(str(created)[:10])
        f = date.fromisoformat(str(closed)[:10])
        return max(0, (f - c).days)
    except Exception:
        return None


def fetch(rd_client) -> list[dict]:
    """
    Fetch all deals from RD Station and return a list of rows ready
    for BigQuery insertion.

    One row per deal per run. The BigQuery writer (upsert_rows) deletes
    today's rows before inserting, so running this multiple times in one
    day is safe — you always end up with exactly one snapshot per deal
    per day.
    """
    today = date.today().isoformat()

    # ── Step 1: fetch deals ────────────────────────────────────────────────────
    print(f"  [leads] Fetching all deals...")
    deals = rd_client.get_all_deals()

    # ── Step 2: build pipeline map ────────────────────────────────────────────
    # GET /deal_pipelines returns all funnels with their stages nested inside.
    # We build two maps keyed by stage_id:
    #   stage_pipeline_map  →  stage_id: pipeline_id   (opaque ID for joins)
    #   stage_pname_map     →  stage_id: pipeline_name (human-readable label)
    #
    # Why not use GET /deal_stages?
    # Without a pipeline filter, /deal_stages only returns stages from the
    # DEFAULT funnel. If you have 5 funnels (as you do), you'd miss 4 of them.
    # /deal_pipelines returns ALL funnels in one call.
    #
    # Why store pipeline_name in the row instead of joining later?
    # Simplicity. A separate lookup table would be more normalized, but for
    # a system this size it adds infrastructure (another table, another query)
    # without meaningful benefit. If RD Station renames a funnel, we just
    # re-run the pipeline and the new name appears in fresh rows going forward.
    pipelines = rd_client.get_deal_pipelines()

    stage_pipeline_map = {}  # stage_id -> pipeline_id
    stage_pname_map    = {}  # stage_id -> pipeline_name

    for p in pipelines:
        pid   = p.get("id", "")
        pname = p.get("name", "")
        for s in p.get("deal_stages", []):
            sid = s.get("id")
            if sid:
                stage_pipeline_map[sid] = pid
                stage_pname_map[sid]    = pname

    print(f"  [leads] {len(deals)} deals across {len(pipelines)} pipelines")

    # ── Step 3: shape each deal into a row ────────────────────────────────────
    rows = []

    for d in deals:
        stage_id      = (d.get("deal_stage") or {}).get("id", "")
        pipeline_id   = stage_pipeline_map.get(stage_id, "")
        pipeline_name = stage_pname_map.get(stage_id, "")

        user        = d.get("user") or {}
        source      = (d.get("deal_source") or {}).get("name", "")
        campaign    = (d.get("campaign") or {}).get("name", "")
        loss_raw    = d.get("deal_lost_reason") or {}
        loss_reason = loss_raw.get("name", "") if isinstance(loss_raw, dict) else str(loss_raw)

        # Determine deal status from the win/hold fields.
        # RD Station uses: win=True (won), win=False (lost), hold=True (paused),
        # win=None + hold=None (open/in progress).
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
            "deal_id":           d.get("id", ""),
            "name":              d.get("name", ""),
            "pipeline_id":       pipeline_id,
            "pipeline_name":     pipeline_name,
            "stage":             (d.get("deal_stage") or {}).get("name", ""),
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
            "run_date":          today,
        })

    print(f"  [leads] {len(rows)} rows ready for BigQuery")
    return rows
