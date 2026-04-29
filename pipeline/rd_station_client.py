"""RD Station API client — stub, to be implemented."""


class RDStationClient:
    def __init__(self):
        import os
        self.api_key = os.environ.get("RD_STATION_API_KEY", "")

    def get_leads(self) -> list:
        # TODO: implement RD Station leads endpoint
        return []
