"""RD Station CRM API client."""

import json
import urllib.request
import urllib.error


BASE_URL = "https://crm.rdstation.com/api/v1"


class RDStationClient:
    def __init__(self):
        import os
        self.token = os.environ.get("RD_STATION_API_KEY", "")

    def _get(self, path: str, params: dict = None) -> dict | None:
        qs = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        sep = "&" if qs else ""
        url = f"{BASE_URL}{path}?token={self.token}{sep}{qs}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            print(f"[RDStation] HTTP {e.code} on GET {path}")
            return None
        except Exception as e:
            print(f"[RDStation] Error on GET {path}: {e}")
            return None

    def get_all_deals(self) -> list:
        """Fetch all deals paginated."""
        all_deals = []
        page = 1
        while True:
            d = self._get("/deals", {"page": page, "limit": 200})
            if not d:
                break
            deals = d.get("deals", [])
            all_deals.extend(deals)
            if not d.get("has_more"):
                break
            page += 1
        return all_deals

    def get_deal_stages(self) -> list:
        # ATENÇÃO: sem o parâmetro deal_pipeline_id, /deal_stages devolve
        # apenas as etapas do FUNIL PADRÃO (máx. 12). Para pegar as etapas
        # de todos os funis, prefira get_deal_pipelines() (abaixo), que já
        # traz cada funil com suas etapas aninhadas em uma única resposta.
        d = self._get("/deal_stages")
        return d.get("deal_stages", []) if d else []

    def get_deal_pipelines(self) -> list:
        """
        Lista TODOS os funis de vendas, cada um com suas etapas aninhadas.

        GET /deal_pipelines  -> a raiz da resposta é uma LISTA (não um dict):
          [
            {
              "id": "PIPE_A",
              "name": "Funil Produto 1",
              "deal_stages": [ {"id": "ST1", "name": "Sem contato"}, ... ]
            },
            ...
          ]

        É a fonte ideal para montar o mapa etapa->funil: uma (ou poucas)
        chamada(s) cobrem todos os funis de uma vez.
        """
        all_pipelines = []
        page = 1
        limit = 200  # máximo permitido pelo endpoint
        while True:
            d = self._get("/deal_pipelines", {"page": page, "limit": limit})
            # a raiz é uma lista; se vier None (erro) ou algo inesperado, para
            if not isinstance(d, list) or not d:
                break
            all_pipelines.extend(d)
            # sem envelope has_more: se a página veio "incompleta", acabou
            if len(d) < limit:
                break
            page += 1
        return all_pipelines

    def get_all_tasks(self) -> list:
        """Fetch all tasks paginated."""
        all_tasks = []
        page = 1
        while True:
            d = self._get("/tasks", {"page": page, "limit": 200})
            if not d:
                break
            tasks = d.get("tasks", [])
            all_tasks.extend(tasks)
            if not d.get("has_more"):
                break
            page += 1
        return all_tasks

    def get_users(self) -> list:
        d = self._get("/users")
        return d.get("users", []) if d else []
