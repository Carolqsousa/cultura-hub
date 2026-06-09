"""
parse_sponte_xls.py
===================
Parses the Sponte "Matrículas e Rematrículas" XLS export into a clean
list of cancellation records ready to load into BigQuery.

Structure discovered from real file:
  - Row 0,  col 8:  Branch name (e.g. "Cultura Inglesa BV")
  - Row N,  col 0:  "Turma: <class_name>"  → class header
  - Row N,  col 23: "Professor: <name>"    → teacher (same row as Turma)
  - Row N+1,col 0:  "Estágio: <stage>"     → stage
  - Data rows: col 4 == "Rescisão" (or other tipo)
      col 0:  date       (dd/mm/yyyy)
      col 4:  tipo       (Rescisão / Trancamento / etc.)
      col 10: student name
      col 17: contract   (e.g. "16968/2")
      col 20: modality
      col 31: reason
      col 40: attendant
  - Summary rows: col 0 starts with "Matrículas:" → skip
  - "Total Geral:" row onwards → skip

Usage:
  python3 parse_sponte_xls.py path/to/file.xls [branch_override]

Returns JSON to stdout — pipe to BigQuery loader or save to file.
"""

import sys
import json
import re
import pandas as pd
from datetime import datetime

# ── Types to extract (add more if needed) ────────────────────────
TIPOS_WANTED = {"Rescisão", "Trancamento", "Cancelamento",
                "Matrícula", "Rematrícula", "Transferência"}

def parse_date(val):
    """Parse dd/mm/yyyy string → ISO date string yyyy-mm-dd"""
    if not val or pd.isna(val):
        return None
    s = str(val).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return s  # return raw if unparseable

def extract_class_name(raw):
    """'Turma: 02BGN1S10 - 2026.1' → '02BGN1S10 - 2026.1'"""
    return re.sub(r"^Turma:\s*", "", str(raw)).strip()

def extract_teacher(raw):
    """'Professor: Telia Portela' → 'Telia Portela'"""
    return re.sub(r"^Professor:\s*", "", str(raw)).strip()

def extract_stage(raw):
    """'Estágio: BEGINNER 2 (F)' → 'BEGINNER 2 (F)'"""
    return re.sub(r"^Estágio:\s*", "", str(raw)).strip()

def extract_stage_code(stage_full):
    """'BEGINNER 2 (F)' → 'BGN' using same mapping as main.py"""
    mapping = {
        "ADV": "ADV", "ADVANCED": "ADV",
        "BGN": "BGN", "BEGINNER": "BGN",
        "ELE": "ELE", "ELEMENTARY": "ELE",
        "INT": "INT", "INTERMEDIATE": "INT",
        "MST": "MST", "MASTER": "MST",
        "PRI": "PRI", "PRE": "PRI", "PRE INTERMEDIATE": "PRI",
        "TEA": "TEA",
        "TEE": "TEE", "TEEN": "TEE",
        "UPP": "UPP", "UPPER": "UPP",
        "VAN": "VAN",
    }
    s = stage_full.upper()
    for key, code in mapping.items():
        if key in s:
            return code
    return "?"

def extract_semester(class_name):
    """'02BGN1S10 - 2026.1' → '2026.1'"""
    m = re.search(r"\d{4}\.\d", class_name)
    return m.group(0) if m else None

def clean_contract(raw):
    """'16968/2' → contract_id=16968, parcel=2"""
    s = str(raw).strip()
    m = re.match(r"^(\d+)/(\d+)$", s)
    if m:
        return int(m.group(1)), int(m.group(2))
    try:
        return int(s), None
    except ValueError:
        return None, None

def parse_xls(path, branch_override=None, force_engine=None):
    """
    Parse one Sponte XLS file or Google-Sheets-exported XLSX.
    Returns list of dicts, one per cancellation/event row.
    force_engine: "openpyxl" for xlsx exports, None = auto (xlrd for .xls)
    """
    engine = force_engine or "xlrd"
    df = pd.read_excel(path, engine=engine, header=None, sheet_name=0)

    # ── Branch from row 0, col 8 ─────────────────────────────────
    branch_raw = str(df.iloc[0, 8]).strip() if pd.notna(df.iloc[0, 8]) else ""
    # Normalise: "Cultura Inglesa BV" → "BV", "Cultura Inglesa Young" → "Young"
    branch = branch_override or re.sub(r"Cultura Inglesa\s*", "", branch_raw).strip()
    if not branch:
        branch = branch_raw

    records = []
    current_class   = None
    current_teacher = None
    current_stage   = None

    for i, row in df.iterrows():
        col0 = str(row.iloc[0]).strip() if pd.notna(row.iloc[0]) else ""
        col4 = str(row.iloc[4]).strip() if pd.notna(row.iloc[4]) else ""

        # ── Stop at Total Geral ───────────────────────────────────
        if col0.startswith("Total Geral"):
            break

        # ── Class header row ─────────────────────────────────────
        if col0.startswith("Turma:"):
            current_class   = extract_class_name(col0)
            current_teacher = extract_teacher(str(row.iloc[23]).strip()
                                              if pd.notna(row.iloc[23]) else "")
            current_stage   = None  # filled on next row
            continue

        # ── Stage row ─────────────────────────────────────────────
        if col0.startswith("Estágio:"):
            current_stage = extract_stage(col0)
            continue

        # ── Summary row (skip) ────────────────────────────────────
        if col0.startswith("Matrículas:") or col4 == "Tipo":
            continue

        # ── Data row ─────────────────────────────────────────────
        if col4 in TIPOS_WANTED:
            date_val     = row.iloc[0]
            student_name = str(row.iloc[10]).strip() if pd.notna(row.iloc[10]) else ""
            contract_raw = str(row.iloc[17]).strip() if pd.notna(row.iloc[17]) else ""
            modality     = str(row.iloc[20]).strip() if pd.notna(row.iloc[20]) else ""
            reason       = str(row.iloc[31]).strip() if pd.notna(row.iloc[31]) else ""
            attendant    = str(row.iloc[40]).strip() if pd.notna(row.iloc[40]) else ""

            contract_id, parcel = clean_contract(contract_raw)
            stage_code = extract_stage_code(current_stage or "")
            semester   = extract_semester(current_class or "")

            records.append({
                "branch":        branch,
                "semester":      semester,
                "event_date":    parse_date(date_val),
                "tipo":          col4,                    # Rescisão / Trancamento / etc.
                "student_name":  student_name,
                "contract_id":   contract_id,
                "parcel":        parcel,
                "modality":      modality,
                "class_name":    current_class,
                "teacher":       current_teacher,
                "stage_full":    current_stage,
                "stage":         stage_code,
                "reason":        reason,
                "attendant":     attendant,
                # Derived flags
                "is_turma_nao_formou": "turma não formou" in reason.lower(),
                "is_real_churn":       "turma não formou" not in reason.lower(),
            })

    return records


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 parse_sponte_xls.py <file.xls> [branch_name]")
        sys.exit(1)

    path   = sys.argv[1]
    branch = sys.argv[2] if len(sys.argv) > 2 else None

    records = parse_xls(path, branch_override=branch)

    print(json.dumps(records, ensure_ascii=False, indent=2))
    print(f"\n# Total records: {len(records)}", file=sys.stderr)

    # Summary by reason
    from collections import Counter
    reasons = Counter(r["reason"] for r in records)
    print("\n# By reason:", file=sys.stderr)
    for reason, count in reasons.most_common():
        marker = " ← turma não formou (operational)" if "turma não formou" in reason.lower() else ""
        print(f"#   {count:3d}  {reason}{marker}", file=sys.stderr)

    real_churn = sum(1 for r in records if r["is_real_churn"])
    print(f"\n# Real churn (excl. turma não formou): {real_churn}", file=sys.stderr)


if __name__ == "__main__":
    main()
