"""Google Sheets client — stub, to be implemented."""


class GoogleSheetsClient:
    def __init__(self):
        import os
        self.sheet_id = os.environ.get("GOOGLE_SHEETS_ID", "")

    def get_goals(self) -> list:
        # TODO: implement
        return []

    def get_todos(self) -> list:
        # TODO: implement
        return []

    def get_teacher_attendance(self) -> list:
        # TODO: implement
        return []

    def get_nps(self) -> list:
        # TODO: implement
        return []
