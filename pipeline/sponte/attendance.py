"""
pipeline/sponte/attendance.py
==============================
Busca frequência individual de todos os alunos ativos por unidade.

Como funciona:
  - Loop por turmas abertas do semestre
  - Para cada aluno na turma: POST /lessons com date range do semestre
  - Calcula presences, absences, total_lessons, pct_presence
  - Uma row por aluno por turma

Por que é lento:
  - 1 chamada API por aluno (~1000 alunos = ~1000 chamadas)
  - Roda só aos domingos para não sobrecarregar a API
  - Rate delay de 0.08s entre chamadas (~80s total de espera)

Requer phase_id:
  - Mesmo padrão do grades.py — extrai do schedule da turma
  - Alunos sem phase no schedule são pulados (mesmo comportamento do grades)
"""

import time
import requests
from datetime import date

RATE_DELAY = 0.08


class AttendanceFetcher:

    def __init__(self, api_key: str, branch: str, semester: str,
                 base_url: str, start_date: str, end_date: str):
        self.branch     = branch
        self.semester   = semester
        self.base_url   = base_url.rstrip("/")
        self.start_date = start_date
        self.end_date   = end_date
        self.headers    = {
            "Accept":       "application/json",
            "Content-Type": "application/json",
            "api_key":      api_key,
        }
        self._phases_map: dict[str, int] = {}

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
        return r.json() if r.status_code == 200 else None

    def _load_phases(self):
        data = self._get("phases")
        self._phases_map = {p["name"]: p["phase_id"] for p in data}

    def _resolve_phase(self, detalhes: dict) -> int | None:
        for s in detalhes.get("schedule", []):
            if s.get("phase"):
                return self._phases_map.get(s["phase"])
        return None

    def _get_lessons(self, student_id: int, class_id: int, phase_id: int) -> list:
        r = requests.post(
            f"{self.base_url}/lessons",
            headers=self.headers,
            json={
                "class_id":   class_id,
                "student_id": student_id,
                "situation":  1,        # 1 = aulas dadas
                "phase_id":   phase_id,
            },
            params={
                "start_date": self.start_date,
                "end_date":   self.end_date,
            },
            timeout=30,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        return data if isinstance(data, list) else []

    def _calcular_frequencia(self, lessons: list) -> dict:
        """
        Calcula presences, absences, total, pct a partir da lista de /lessons.
        presence=1 → presente | presence=0 → falta
        """
        if not lessons:
            return {
                "presences":     None,
                "absences":      None,
                "total_lessons": None,
                "pct_presence":  None,
            }
        presences = sum(1 for l in lessons if l.get("presence") == 1)
        absences  = sum(1 for l in lessons if l.get("presence") == 0)
        total     = len(lessons)
        pct       = round(presences / total * 100, 1) if total else 0.0
        return {
            "presences":     presences,
            "absences":      absences,
            "total_lessons": total,
            "pct_presence":  pct,
        }

    def fetch(self) -> list[dict]:
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

            phase_id = self._resolve_phase(detalhes)
            if not phase_id:
                continue

            members = detalhes.get("members", [])

            for aluno in members:
                student_id = aluno.get("student_id")
                if not student_id:
                    continue

                lessons = self._get_lessons(student_id, class_id, phase_id)
                time.sleep(RATE_DELAY)

                freq = self._calcular_frequencia(lessons)

                rows.append({
                    "date":         run_today,
                    "branch":       self.branch,
                    "student_id":   str(student_id),
                    "class_id":     str(class_id),
                    "class_name":   class_name,
                    **freq,
                    "run_date":     run_today,
                })

        print(f"  [{self.branch}] {len(rows)} linhas coletadas")
        return rows
