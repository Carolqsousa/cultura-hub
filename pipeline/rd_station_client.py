"""RD Station CRM API client."""

import json
import time
import urllib.request
import urllib.error


BASE_URL = "https://crm.rdstation.com/api/v1"
TIMEOUT      = 20   # seconds before a single attempt fails fast instead of hanging
                     # (raised from 10s -- a real production timeout was hit at 10s
                     # under normal API load, not a genuine outage)
DELAY        = 0.5  # seconds between successful paginated requests (rate limiting)
RETRY_COUNT  = 3     # attempts per request before giving up entirely
RETRY_DELAY  = 2     # seconds before the first retry; doubles each subsequent attempt

# HTTP codes that mean "this will never succeed by retrying" -- a bad token
# or bad URL doesn't fix itself. Retrying these just delays an inevitable
# failure. Anything not in this set (timeouts, 5xx server errors, etc.) is
# treated as transient and worth retrying.
_NON_TRANSIENT_HTTP_CODES = {400, 401, 403, 404}

# RD Station's list endpoints (deals, companies, contacts, tasks) hit a
# hard wall at 10,000 records per fetch -- confirmed against their own
# docs after get_all_tasks crashed in production on 2026-07-09 (HTTP 400
# on page 51, right at the 10k mark). There is no way to page past this;
# the only fix is to shrink what you're asking for (e.g. done=False)
# before you get there. This constant is a tripwire, not a limit we
# enforce -- it just makes the wall visible in logs well before you hit
# it, instead of finding out via a crashed pipeline run.
_SOFT_CAP_WARNING = 8000


class RDStationAPIError(Exception):
    """
    Raised when a paginated fetch fails partway through, instead of
    silently returning whatever was collected so far.

    WHY THIS EXISTS: the previous version of get_all_deals()/get_all_tasks()/
    get_deal_pipelines() treated "a request failed" and "we reached the
    natural end of the data" identically -- both just stopped the loop and
    returned whatever had been collected, with no error and no warning.
    That means a network blip on page 6 of 12 would silently ship a
    half-complete dataset to BigQuery as if it were the whole picture --
    the same "silent partial failure" shape found elsewhere in this
    project (e.g. one branch's students.py upload failing while others
    succeed). Raising here instead means a failed run shows up as a loud,
    visible failure (red X in GitHub Actions) rather than a clean-looking
    run with quietly wrong, incomplete data.
    """
    pass


class RDStationClient:
    def __init__(self, token: str | None = None, label: str = ""):
        """
        Parameters
        ----------
        token : str, optional
            RD Station API token to use. If omitted, falls back to the
            RD_STATION_API_KEY environment variable -- this is the exact
            previous behavior, unchanged, so every existing caller like
            `RDStationClient()` keeps working with zero changes needed.
            Pass an explicit token to talk to a DIFFERENT RD Station
            account (e.g. Natal's separate account, which has its own
            funnels/stages/custom fields and its own deal_id numbering):
                RDStationClient(token=os.environ["RD_STATION_API_KEY_NATAL"],
                                 label="Natal")
        label : str, optional
            Short name shown in log/error messages only, so failures from
            two different accounts running in the same log stream can be
            told apart at a glance, e.g. "[RDStation:Natal] HTTP 401 on
            GET /deals" vs "[RDStation] HTTP 401 on GET /deals".
        """
        import os
        self.token = token if token is not None else os.environ.get("RD_STATION_API_KEY", "")
        self.label = f":{label}" if label else ""

    def _get(self, path: str, params: dict = None) -> dict | None:
        """
        Makes a GET request, retrying transient failures (timeouts, 5xx
        errors) up to RETRY_COUNT times with increasing delay before giving
        up. Non-transient failures (bad token, bad URL -- see
        _NON_TRANSIENT_HTTP_CODES) fail immediately on the first attempt,
        since retrying can't fix a wrong credential.

        Returns None only after every retry has been exhausted (or
        immediately for a non-transient error) -- callers (get_all_deals,
        etc.) treat None as "this call genuinely failed" and raise
        RDStationAPIError rather than silently continuing with partial data.
        """
        qs  = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        sep = "&" if qs else ""
        url = f"{BASE_URL}{path}?token={self.token}{sep}{qs}"

        last_error = None
        for attempt in range(1, RETRY_COUNT + 1):
            req = urllib.request.Request(url)
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                    return json.loads(res.read().decode())
            except urllib.error.HTTPError as e:
                if e.code in _NON_TRANSIENT_HTTP_CODES:
                    print(f"[RDStation{self.label}] HTTP {e.code} on GET {path} "
                          f"-- not retrying, this won't succeed on retry")
                    return None
                last_error = e
                print(f"[RDStation{self.label}] HTTP {e.code} on GET {path} "
                      f"(attempt {attempt}/{RETRY_COUNT})")
            except Exception as e:
                last_error = e
                print(f"[RDStation{self.label}] Error on GET {path} "
                      f"(attempt {attempt}/{RETRY_COUNT}): {e}")

            if attempt < RETRY_COUNT:
                time.sleep(RETRY_DELAY * attempt)  # 2s, then 4s

        print(f"[RDStation{self.label}] GET {path} failed after {RETRY_COUNT} "
              f"attempts, last error: {last_error}")
        return None

    def _warn_if_near_cap(self, entity: str, count: int) -> None:
        """
        Logs a visible warning once a paginated fetch crosses
        _SOFT_CAP_WARNING, well before RD Station's real 10,000-record
        wall would turn into a hard failure. Call this after each page is
        appended, not just at the end -- the goal is to see it coming in
        the logs of a run that still succeeded, not only after one fails.
        """
        if count == _SOFT_CAP_WARNING:
            print(f"⚠️  [RDStation{self.label}] {entity} fetch has reached "
                  f"{count} records -- RD Station's list endpoints cap out "
                  f"at 10,000. Approaching the wall; consider narrowing this "
                  f"fetch (date range, status filter, etc.) before it starts "
                  f"failing outright.")

    # ── Deals ──────────────────────────────────────────────────────────────────

    def get_all_deals(self) -> list:
        """
        Fetch all deals, paginated.

        RD Station returns deals in pages of up to 200. We keep fetching
        until has_more is False. A 0.5s delay between pages keeps us inside
        the API rate limit — without it, back-to-back requests get throttled
        and the loop hangs indefinitely.

        Raises RDStationAPIError if any page request fails (network error,
        bad token, timeout, etc.) instead of silently returning whatever
        was collected before the failure — a half-complete deal list is
        worse than no list, since nothing downstream would know it's
        incomplete.
        """
        all_deals = []
        page = 1
        while True:
            d = self._get("/deals", {"page": page, "limit": 200})
            if d is None:
                raise RDStationAPIError(
                    f"[RDStation{self.label}] get_all_deals failed on page {page} "
                    f"after collecting {len(all_deals)} deals -- aborting rather than "
                    f"returning a silently incomplete list."
                )
            deals = d.get("deals", [])
            all_deals.extend(deals)
            self._warn_if_near_cap("get_all_deals", len(all_deals))
            if not d.get("has_more"):
                break
            page += 1
            time.sleep(DELAY)
        return all_deals

    # ── Pipelines & stages ─────────────────────────────────────────────────────

    def get_deal_pipelines(self) -> list:
        """
        Fetch ALL sales funnels, each with their stages nested inside.

        GET /deal_pipelines returns a flat list (not a dict), e.g.:
          [
            {
              "id": "PIPE_A",
              "name": "Funil BOA VIAGEM",
              "deal_stages": [
                {"id": "ST1", "name": "Sala de Espera"},
                {"id": "ST2", "name": "Interesse"},
                ...
              ]
            },
            ...
          ]

        This is the correct source for building a stage->pipeline map.
        Do NOT use /deal_stages for this — without a pipeline filter it
        only returns stages from the default funnel, missing all others.
        """
        all_pipelines = []
        page  = 1
        limit = 200
        while True:
            d = self._get("/deal_pipelines", {"page": page, "limit": limit})
            if d is None:
                raise RDStationAPIError(
                    f"[RDStation{self.label}] get_deal_pipelines failed on page {page} "
                    f"after collecting {len(all_pipelines)} pipelines -- aborting rather "
                    f"than returning a silently incomplete list. A partial pipeline map "
                    f"would misassign deals to the wrong funnel with no error."
                )
            if not isinstance(d, list) or not d:
                break
            all_pipelines.extend(d)
            if len(d) < limit:
                break
            page += 1
            time.sleep(DELAY)
        return all_pipelines

    def get_deal_stages(self) -> list:
        """
        Returns stages from the DEFAULT funnel only.
        Use get_deal_pipelines() instead when you need all funnels.
        Kept here for backwards compatibility.
        """
        d = self._get("/deal_stages")
        return d.get("deal_stages", []) if d else []

    # ── Tasks ──────────────────────────────────────────────────────────────────

    def get_all_tasks(self, done: bool | None = None) -> list:
        """
        Fetch tasks, paginated. Raises RDStationAPIError on a failed page
        instead of silently returning a truncated list.

        Parameters
        ----------
        done : bool or None, optional
            Server-side filter passed to RD Station. Default None fetches
            every task regardless of status -- unchanged old behavior, so
            any other existing caller of get_all_tasks() keeps working
            exactly as before.

            Pass done=False to fetch only incomplete tasks. This isn't
            just a convenience filter -- RD Station's list endpoints cap
            out at 10,000 records per fetch (confirmed against their docs
            after this hit production on 2026-07-09: HTTP 400 on page 51,
            right at 10,000 tasks collected). The filter has to be applied
            server-side to help, since the cap is hit *while fetching*,
            before any local filtering ever gets a chance to run.
        """
        all_tasks = []
        page = 1
        while True:
            params = {"page": page, "limit": 200}
            if done is not None:
                params["done"] = "true" if done else "false"
            d = self._get("/tasks", params)
            if d is None:
                raise RDStationAPIError(
                    f"[RDStation{self.label}] get_all_tasks failed on page {page} "
                    f"after collecting {len(all_tasks)} tasks -- aborting rather than "
                    f"returning a silently incomplete list."
                )
            tasks = d.get("tasks", [])
            all_tasks.extend(tasks)
            self._warn_if_near_cap("get_all_tasks", len(all_tasks))
            if not d.get("has_more"):
                break
            page += 1
            time.sleep(DELAY)
        return all_tasks

    # ── Users ──────────────────────────────────────────────────────────────────

    def get_users(self) -> list:
        d = self._get("/users")
        return d.get("users", []) if d else []
