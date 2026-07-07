"""
pipeline/rd_station/leads.py
Fetches deals from RD Station CRM with full field mapping.

Each daily run produces one row per deal, capturing its current state.
History is preserved by keeping all past runs in BigQuery (append pattern).

The pipeline map (stage_id -> pipeline) is built ONCE in run_leads.py
and passed in here — shared with tasks.py to avoid redundant API calls.
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

    Risk: if someone renames the field in RD Station, this silently
    returns None with no error. A more robust approach would match by
    custom_field_id (the immutable MongoDB ID), but label matching is
    the practical choice for now.
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


# Natal's RD Station account has recorded "Temperatura do Lead" using TWO
# different dropdown option sets over its history -- likely the options
# were changed at some point, with older deals keeping their original
# values. The main account only ever uses Quente/Morno/Frio. Without this,
# ~17% of Natal's leads (the Alto/Médio/Baixo rows) would silently fail
# to match any known temperature in downstream charts/filters -- not an
# error, just quietly miscategorized or dropped.
# Mapping confirmed directionally correct: Alto (high interest) = Quente
# (hot), Baixo (low interest) = Frio (cold).
_TEMP_SCALE_NORMALIZE = {
    "Alto":  "Quente",
    "Médio": "Morno",
    "Baixo": "Frio",
}


def _normalize_temperature(raw):
    """Maps Natal's alternate Alto/Médio/Baixo scale onto the standard
    Quente/Morno/Frio scale. Values already in the standard scale (or
    empty) pass through unchanged -- this is a no-op for the main account."""
    if not raw:
        return raw
    return _TEMP_SCALE_NORMALIZE.get(raw, raw)


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
    We keep only '2026-07-02' — time and timezone aren't needed for the
    analyses this table supports.
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


def fetch(rd_client, stage_pipeline_map: dict, stage_pname_map: dict) -> list[dict]:
    """
    Fetch all deals from RD Station and return rows ready for BigQuery.

    Parameters
    ----------
    rd_client
        The RD Station API client.

    stage_pipeline_map : dict
        stage_id -> pipeline_id. Built once in run_leads.py and shared
        with tasks.py so /deal_pipelines is only called once per run.

    stage_pname_map : dict
        stage_id -> pipeline_name. Same sharing pattern.

    Why receive the maps instead of building them internally?
    Both leads.py and tasks.py need to resolve pipeline from stage_id.
    Building the map once in run_leads.py and passing it to both avoids
    a redundant API call and guarantees both tables use identical mapping
    within the same run.
    """
    today = date.today().isoformat()

    print(f"  [leads] Fetching all deals...")
    deals = rd_client.get_all_deals()
    print(f"  [leads] {len(deals)} deals to process")

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
        # RD Station uses: win=True (won), win=False (lost),
        # hold=True (paused), win=None + hold=None (open).
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
            "temperature":       _normalize_temperature(_custom_field(d, "Temperatura do Lead")) or "",
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
