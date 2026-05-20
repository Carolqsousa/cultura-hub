"""
pipeline/run_grades.py
======================
Runner do pipeline de notas.
Segue o mesmo padrão dos outros runners (run_students.py, run_financials.py):
  1. Lê configs do ambiente
  2. Roda o fetcher por unidade
  3. Deleta dados antigos da unidade no BigQuery
  4. Insere novos dados via load job (não streaming)
"""

import os
import sys
import json
import tempfile
from datetime import date

# Adiciona a raiz do projeto ao path (necessário quando rodado pelo GitHub Actions)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.sponte.grades import GradesFetcher
from pipeline.bigquery.client import BigQueryClient

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL = "https://webservices.sponteweb.com.br/WSApiSponteRest/api"
SEMESTER = os.getenv("SPONTE_SEMESTER", "2026.1")
DATASET  = "cultura_hub"
TABLE    = "grades"

# Cada unidade tem sua própria API key
BRANCHES = {
    "Boa Viagem": os.getenv("SPONTE_API_KEY_BOA_VIAGEM"),
    "Young":      os.getenv("SPONTE_API_KEY_YOUNG"),
    "Setubal":    os.getenv("SPONTE_API_KEY_SETUBAL"),
    "Natal":      os.getenv("SPONTE_API_KEY_NATAL"),
}


def run_branch(branch: str, api_key: str, bq: BigQueryClient) -> int:
    """
    Roda o fetcher para uma unidade e persiste no BigQuery.
    Retorna o número de rows inseridas.

    Por que delete + insert em vez de UPSERT:
      BigQuery não tem UPDATE eficiente em tabelas grandes.
      A estratégia é deletar as linhas do dia/branch antes de inserir.
      Isso evita duplicatas se o pipeline rodar mais de uma vez por dia.
    """
    if not api_key:
        print(f"  [{branch}] ⚠️  API key não configurada, pulando")
        return 0

    print(f"\n  [{branch}] Buscando notas...")
    fetcher = GradesFetcher(
        api_key=api_key,
        branch=branch,
        semester=SEMESTER,
        base_url=BASE_URL,
    )
    rows = fetcher.fetch()

    if not rows:
        print(f"  [{branch}] Nenhuma nota encontrada")
        return 0

    # Deleta registros do dia para esta branch antes de inserir
    # Evita duplicatas se o pipeline rodar duas vezes no mesmo dia
    today = date.today().isoformat()
    bq.delete_rows(
        dataset=DATASET,
        table=TABLE,
        where=f"date = '{today}' AND branch = '{branch}'",
    )

    # Insere via load job (não streaming — permite DELETE imediato se necessário)
    bq.insert_rows(dataset=DATASET, table=TABLE, rows=rows)
    print(f"  [{branch}] ✅ {len(rows)} rows inseridas")
    return len(rows)


def main():
    print(f"=== Pipeline Grades | {date.today()} | Semestre {SEMESTER} ===\n")

    # Carrega credenciais GCP do ambiente
    # Em GitHub Actions: vem do secret GCP_CREDENTIALS_JSON como string JSON
    gcp_creds_json = os.getenv("GCP_CREDENTIALS_JSON")
    gcp_project    = os.getenv("GCP_PROJECT_ID", "cultura-hub")

    if not gcp_creds_json:
        print("❌ GCP_CREDENTIALS_JSON não configurado")
        sys.exit(1)

    # Escreve credenciais num arquivo temporário (gspread/google-auth exige arquivo)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(gcp_creds_json)
        creds_path = f.name

    bq = BigQueryClient(credentials_path=creds_path, project=gcp_project)

    total = 0
    errors = []
    for branch, api_key in BRANCHES.items():
        try:
            total += run_branch(branch, api_key, bq)
        except Exception as e:
            print(f"  [{branch}] ❌ Erro: {e}")
            errors.append(branch)

    print(f"\n=== Concluído: {total} rows | {len(errors)} erros ===")
    if errors:
        print(f"  Branches com erro: {errors}")
        sys.exit(1)


if __name__ == "__main__":
    main()
