"""
pipeline/sponte/grades.py
=========================
Busca notas de todos os alunos ativos por unidade.

FORMATO A  (PC / Mid-term / Final)
  Phases: tudo que NÃO está em PHASES_FORMATO_B
  Calcula: pc_average, midterm_average, final_average, overall_average
  Aprovação: overall_average >= 7.0 (quando há notas suficientes)

FORMATO B  (AVALIAÇÃO 1/2/3/4)
  Phases: ADVANCED 1/2, MASTERY 1/2, VANTAGE 1/2, UPPER INTERMEDIATE 3
  Não calcula média — armazena only format=B, sem averages
  Razão: as sub-avaliações do Formato B não chegam via API de forma útil

COMO O phase_id É RESOLVIDO
  Nunca usa phase_id negativo genérico (-1, -6, etc.)
  Extrai phase_nome do schedule da turma → mapeia para phase_id positivo
  Isso garante que o /scores retorna a estrutura correta para cada fase

DADOS QUE VÃO PARA O BIGQUERY (tabela grades)
  Uma linha por aluno por turma por run_date
  Partial data (só Mid-term lançado) é salvo normalmente — approved=NULL
"""

import time
import requests
from datetime import date

# ── Phases que usam Formato B ─────────────────────────────────────────────────
# Identificação é por phase_name (do schedule da turma), não pelo nome da turma
PHASES_FORMATO_B = {
    # Format B — avaliações 1/2/3/4 sem médias via API
    "ADVANCED 1 (F)",
    "ADVANCED 2 (F)",
    "MASTERY 1 (F)",
    "MASTERY 2 (F)",
    "VANTAGE 1 (F)",
    "VANTAGE 2 (F)",
    "UPPER INTERMEDIATE 3 (F)",
}

# ── Phases sem notas (early childhood) ────────────────────────────────────────
# Pre Stars, Nursery e Toddler não usam avaliações formais no Sponte.
# A pipeline salva grade_format='NO_GRADE' sem tentar buscar /scores.
# Prefixes verificados — qualquer phase_name que comece com esses termos
# é tratada como sem nota.
NO_GRADE_PREFIXES = (
    "PRE STARS",
    "NURSERY",
    "TODDLER",
    "CULTURA PLUS - NURSERY",
    "CULTURA PLUS - PRE STARS",
    "CULTURA PLUS - PRE-STARS",
    "THE NEST",
)

def is_no_grade_phase(phase_name: str) -> bool:
    """Returns True if this phase doesn't use formal grades."""
    if not phase_name:
        return False
    upper = phase_name.upper()
    return any(upper.startswith(p) for p in NO_GRADE_PREFIXES)

# test_name exato que a API retorna para Formato A
# (confirmado pelo teste: 'Progress Check', 'Mid-term', 'Final')
PROVA_KEY = {
    "Progress Check": "pc",
    "Mid-term":       "midterm",
    "Final":          "final",
}

APPROVAL_THRESHOLD = 7.0
RATE_DELAY         = 0.08  # segundos entre chamadas API


class GradesFetcher:
    """
    Busca notas de todas as turmas abertas de uma unidade.

    Uso:
        fetcher = GradesFetcher(api_key="...", branch="Boa Viagem", semester="2026.1")
        rows = fetcher.fetch()
        # rows é uma lista de dicts prontos para o BigQuery
    """

    def __init__(self, api_key: str, branch: str, semester: str, base_url: str):
        self.branch   = branch
        self.semester = semester
        self.base_url = base_url.rstrip("/")
        self.headers  = {
            "Accept":       "application/json",
            "Content-Type": "application/json",
            "api_key":      api_key,
        }
        self._phases_map: dict[str, int] = {}

    # ── HTTP helpers ──────────────────────────────────────────────────────────

    def _get(self, endpoint: str):
        r = requests.get(f"{self.base_url}/{endpoint}", headers=self.headers, timeout=30)
        r.raise_for_status()
        return r.json()

    def _post(self, endpoint: str, payload: dict):
        r = requests.post(
            f"{self.base_url}/{endpoint}",
            headers=self.headers,
            json=payload,
            timeout=30,
        )
        if r.status_code != 200:
            return None
        return r.json()

    # ── Phase resolution ──────────────────────────────────────────────────────

    def _load_phases(self):
        """
        Carrega mapa {phase_name: phase_id} uma vez por run.

        Por que isso importa:
          A API /scores exige um phase_id específico da turma.
          Usar um phase_id genérico (como -1 ou -6) retorna a estrutura
          errada — ex: uma turma INT retorna AVALIAÇÃO 1/2/3/4 ao invés
          de PC/Mid/Final, porque -6 aponta para ADVANCED 1 (F).
        """
        data = self._get("phases")
        self._phases_map = {p["name"]: p["phase_id"] for p in data}

    def _resolve_phase(self, detalhes: dict) -> tuple[str | None, int | None]:
        """
        Extrai phase_name e phase_id do schedule da turma.
        Retorna (None, None) se a turma não tiver phase no schedule.
        """
        for s in detalhes.get("schedule", []):
            if s.get("phase"):
                name = s["phase"]
                pid  = self._phases_map.get(name)
                return name, pid
        return None, None

    # ── Score calculation ─────────────────────────────────────────────────────

    def _calcular_media_prova(self, grades: list) -> float | None:
        """
        Média ponderada de uma prova usando o campo 'weight' de cada sub-avaliação.

        Exemplo:
          Speaking (weight=2) score=8, Gramática (weight=1) score=6
          → (8*2 + 6*1) / (2+1) = 7.33

        Se nenhum score preenchido, retorna None.
        """
        soma_n, soma_p = 0.0, 0.0
        for g in grades:
            score = g.get("score")
            if score in (None, "", 0):
                continue
            try:
                val    = float(str(score).replace(",", "."))
                weight = g.get("weight") or 1
                soma_n += val * weight
                soma_p += weight
            except (ValueError, TypeError):
                continue
        return round(soma_n / soma_p, 2) if soma_p > 0 else None

    def _calcular_media_geral(self, medias: dict[str, tuple[float, int]]) -> float | None:
        """
        Média geral ponderada entre provas usando 'test_weight'.

        medias = {"pc": (9.4, 1), "midterm": (8.5, 4), "final": (7.2, 4)}
        → (9.4*1 + 8.5*4 + 7.2*4) / (1+4+4) = 8.19

        test_weight vem da API — não hardcodamos.
        """
        if not medias:
            return None
        soma_m  = sum(m * tw for m, tw in medias.values())
        soma_tw = sum(tw for _, tw in medias.values())
        return round(soma_m / soma_tw, 2) if soma_tw > 0 else None

    def _extrair_notas_formato_a(self, scores_data: dict) -> dict:
        """
        Processa grades[] de Formato A → retorna dict com médias.

        Retorna:
          {
            "pc_average":      float | None,
            "midterm_average": float | None,
            "final_average":   float | None,
            "overall_average": float | None,
            "approved":        bool | None,   # None se ainda sem dados suficientes
            "provas_entered":  str,            # ex: "Progress Check,Mid-term"
          }
        """
        grades = scores_data.get("grades", [])

        # Agrupa grades por prova
        por_prova: dict[str, list] = {}
        for g in grades:
            prova = g.get("test_name", "").strip()
            if prova in PROVA_KEY:
                por_prova.setdefault(prova, []).append(g)

        # Calcula média por prova
        medias_por_key: dict[str, tuple[float, int]] = {}
        resultado = {
            "pc_average":      None,
            "midterm_average": None,
            "final_average":   None,
        }

        provas_entered = []
        for prova_nome, key in PROVA_KEY.items():
            items = por_prova.get(prova_nome, [])
            if not items:
                continue

            media = self._calcular_media_prova(items)
            if media is None:
                continue

            # test_weight: peso desta prova no overall (ex: midterm=4, pc=1)
            tw = items[0].get("test_weight") or 1

            resultado[f"{key}_average"]     = media
            medias_por_key[key]             = (media, tw)
            provas_entered.append(prova_nome)

        # Overall average (só calculável com pelo menos uma prova)
        overall = self._calcular_media_geral(medias_por_key)
        resultado["overall_average"] = overall

        # approved: True/False só quando há dados; None se ainda sem nada
        # ⚠️  RISCO: um aluno com só o PC lançado pode ter overall >= 7
        #    mas ainda ser reprovado depois do Final.
        #    O campo 'approved' aqui é PARCIAL quando provas_entered != todas as 3 provas.
        #    O dashboard deve mostrar isso com cautela.
        resultado["approved"] = (overall >= APPROVAL_THRESHOLD) if overall is not None else None

        resultado["provas_entered"] = ",".join(provas_entered)
        return resultado

    # ── Main fetch ────────────────────────────────────────────────────────────

    def fetch(self) -> list[dict]:
        """
        Retorna lista de rows prontos para carregar no BigQuery.
        Uma row por aluno por turma.
        """
        self._load_phases()

        classes_raw = self._get("classes")
        classes = [
            c for c in classes_raw
            if c.get("situation") == 1 and self.semester in c.get("name", "")
        ]
        print(f"  [{self.branch}] {len(classes)} turmas abertas")

        rows      = []
        run_today = date.today().isoformat()

        for turma in classes:
            class_id   = turma["class_id"]
            class_name = turma["name"]

            detalhes = self._post("classes", {"class_id": class_id})
            if not detalhes:
                continue
            time.sleep(RATE_DELAY)

            phase_name, phase_id = self._resolve_phase(detalhes)

            # Sem phase → não conseguimos buscar /scores
            if not phase_id:
                print(f"    ⚠️  {class_name}: sem phase no schedule, pulando")
                continue

            is_format_b  = phase_name in PHASES_FORMATO_B
            is_no_grade  = is_no_grade_phase(phase_name or "")
            members     = detalhes.get("members", [])

            for aluno in members:
                student_id = aluno.get("student_id")
                if not student_id:
                    continue

                # Early childhood phases (Pre Stars, Nursery, Toddler)
                # don't use formal grades — save row without calling /scores
                if is_no_grade:
                    rows.append({
                        "date":            run_today,
                        "branch":          self.branch,
                        "student_id":      str(student_id),
                        "class_id":        str(class_id),
                        "class_name":      class_name,
                        "phase_name":      phase_name or "",
                        "grade_format":    "NO_GRADE",
                        "pc_average":      None,
                        "midterm_average": None,
                        "final_average":   None,
                        "overall_average": None,
                        "approved":        None,
                        "provas_entered":  "",
                        "run_date":        run_today,
                    })
                    continue

                scores_data = self._post("scores", {
                    "student_id": student_id,
                    "class_id":   class_id,
                    "phase_id":   phase_id,
                })
                time.sleep(RATE_DELAY)

                if not scores_data or not scores_data.get("grades"):
                    # Sem grades retornados — aluno sem configuração de notas
                    continue

                # Monta a row base
                row = {
                    "date":         run_today,
                    "branch":       self.branch,
                    "student_id":   str(student_id),
                    "class_id":     str(class_id),
                    "class_name":   class_name,
                    "phase_name":   phase_name or "",
                    "grade_format": "B" if is_format_b else "A",
                    # Formato A fields (None para Formato B)
                    "pc_average":      None,
                    "midterm_average": None,
                    "final_average":   None,
                    "overall_average": None,
                    "approved":        None,
                    "provas_entered":  "",
                    "run_date":        run_today,
                }

                # Processa notas de Formato A
                # Formato B: guardamos a linha com grade_format=B mas sem médias
                # Isso permite saber quais alunos são Formato B no dashboard
                if not is_format_b:
                    notas = self._extrair_notas_formato_a(scores_data)
                    row.update(notas)

                rows.append(row)

        print(f"  [{self.branch}] {len(rows)} linhas coletadas")
        return rows
