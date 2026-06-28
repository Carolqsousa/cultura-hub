"""
pipeline/run_attendance.py
"""

import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.sponte.attendance import AttendanceFetcher
from pipeline.bigquery.client import upsert_rows

BASE_URL    = "https://webservices.sponteweb.com.br/WSApiSponteRest/api"
SEMESTER    = os.getenv("SPONTE_SEMESTER", "2026.1")
START_DATE  = os.getenv("SPONTE_START",    "2026-02-01")
END_DATE    = os.getenv("SPONTE_END",      "2026-12-31")
TABLE       = "attendance"

BRANCHES = {
    "Boa Viagem": os.getenv("SPONTE_API_KEY_BOA_VIAGEM"),
    "Young":      os.getenv("SPONTE_API_KEY_YOUNG"),
    "Setubal":    os.getenv("SPONTE_API_KEY_SETUBAL"),
    "Natal":      os.getenv("SPONTE_API_KEY_NATAL"),
}


def run_branch(branch: str, api_key: str) -> int:
    if not api_key:
        print(f"  [{branch}] ⚠️  API key não configurada, pulando")
        return 0

    print(f"\n  [{branch}] Buscando frequência...")
    fetcher = AttendanceFetcher(
        api_key=api_key,
        branch=branch,
        semester=SEMESTER,
        base_url=BASE_URL,
        start_date=START_DATE,
        end_date=END_DATE,
    )
    rows = fetcher.fetch()

    if not rows:
        print(f"  [{branch}] Nenhuma frequência encontrada")
        return 0

    upsert_rows(TABLE, rows, branch=branch)
    return len(rows)


def main():
    print(f"=== Pipeline Attendance | {date.today()} | Semestre {SEMESTER} ===\n")

    total  = 0
    errors = []
    for branch, api_key in BRANCHES.items():
        try:
            total += run_branch(branch, api_key)
        except Exception as e:
            print(f"  [{branch}] ❌ Erro: {e}")
            errors.append(branch)

    print(f"\n=== Concluído: {total} rows | {len(errors)} erros ===")
    if errors:
        print(f"  Branches com erro: {errors}")
        if len(errors) == len(BRANCHES):
        sys.exit(1)  # All branches failed — something is seriously wrong


if __name__ == "__main__":
    main()
