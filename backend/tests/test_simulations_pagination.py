"""Pagination for GET /api/sandbox/simulations.

The endpoint used to return a hardcoded LIMIT 50 with no way to reach older
runs and no signal that anything had been withheld — the UI read "50 recorded"
when the org had far more.

The rows are seeded across only a handful of distinct created_at values on
purpose: a sweep stamps its whole batch with one timestamp, so ties are the
normal case, not an edge case. Ordering by created_at alone leaves tied rows in
an undefined order and OFFSET paging can then repeat or skip them, which is what
test_pages_do_not_overlap_or_skip pins down.
"""

from __future__ import annotations

import json
import uuid

import pytest

TOTAL_SIMS = 120
PAGE = 50
# Three timestamps across 120 rows — heavy ties, as a real sweep produces.
TIMESTAMPS = ["2026-01-01", "2026-01-02", "2026-01-03"]


@pytest.fixture()
def seeded_sims(two_orgs):
    """TOTAL_SIMS simulations owned by org_a, none for org_b."""
    from db import get_db

    org_a = two_orgs["org_a"]
    rows = [
        (
            uuid.uuid4().hex[:12],
            "pagination-agent",
            f"scenario-{i}",
            "completed",
            json.dumps({"prompt": "x"}),
            json.dumps({"risk_score": i % 100}),
            org_a["org_id"],
            TIMESTAMPS[i % len(TIMESTAMPS)],
            "live",
        )
        for i in range(TOTAL_SIMS)
    ]
    with get_db() as conn, conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO simulations (id, agent_id, scenario_id, status, trace_json, report_json, org_id, created_at, run_mode) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            rows,
        )
    return two_orgs


def _ids(resp):
    return [s["id"] for s in resp.json()["simulations"]]


class TestDefaults:
    def test_unparameterised_call_is_unchanged(self, client, seeded_sims):
        """Existing callers keep the old page size and gain a total."""
        r = client.get("/api/sandbox/simulations", headers=seeded_sims["org_a"]["headers"])
        assert r.status_code == 200
        body = r.json()
        assert len(body["simulations"]) == PAGE
        assert body["total"] == TOTAL_SIMS
        assert body["limit"] == PAGE
        assert body["offset"] == 0

    def test_total_reveals_withheld_rows(self, client, seeded_sims):
        body = client.get("/api/sandbox/simulations",
                          headers=seeded_sims["org_a"]["headers"]).json()
        assert body["total"] > len(body["simulations"])


class TestPaging:
    def test_offset_reaches_the_tail(self, client, seeded_sims):
        h = seeded_sims["org_a"]["headers"]
        last = client.get(f"/api/sandbox/simulations?limit={PAGE}&offset=100", headers=h)
        assert last.status_code == 200
        assert len(last.json()["simulations"]) == TOTAL_SIMS - 100

    def test_pages_do_not_overlap_or_skip(self, client, seeded_sims):
        """The tiebreaker's reason for existing: a stable total order."""
        h = seeded_sims["org_a"]["headers"]
        pages = [
            _ids(client.get(f"/api/sandbox/simulations?limit={PAGE}&offset={off}", headers=h))
            for off in range(0, TOTAL_SIMS, PAGE)
        ]
        walked = [i for page in pages for i in page]
        assert len(walked) == TOTAL_SIMS
        assert len(set(walked)) == TOTAL_SIMS, "a row was returned on two pages"

    def test_paged_order_matches_unpaged(self, client, seeded_sims):
        h = seeded_sims["org_a"]["headers"]
        whole = _ids(client.get(f"/api/sandbox/simulations?limit={TOTAL_SIMS}", headers=h))
        walked = []
        for off in range(0, TOTAL_SIMS, PAGE):
            walked += _ids(client.get(f"/api/sandbox/simulations?limit={PAGE}&offset={off}", headers=h))
        assert walked == whole

    def test_offset_past_the_end_is_empty_not_an_error(self, client, seeded_sims):
        r = client.get(f"/api/sandbox/simulations?offset={TOTAL_SIMS + 10}",
                       headers=seeded_sims["org_a"]["headers"])
        assert r.status_code == 200
        assert r.json()["simulations"] == []
        assert r.json()["total"] == TOTAL_SIMS


class TestBounds:
    @pytest.mark.parametrize("query", ["limit=0", "limit=501", "offset=-1", "limit=abc"])
    def test_out_of_range_is_rejected(self, client, seeded_sims, query):
        r = client.get(f"/api/sandbox/simulations?{query}",
                       headers=seeded_sims["org_a"]["headers"])
        assert r.status_code == 422

    def test_limit_cap_is_honoured(self, client, seeded_sims):
        r = client.get("/api/sandbox/simulations?limit=500",
                       headers=seeded_sims["org_a"]["headers"])
        assert r.status_code == 200
        assert len(r.json()["simulations"]) == TOTAL_SIMS


class TestOrgScoping:
    def test_total_counts_only_the_callers_org(self, client, seeded_sims):
        """`total` is a second query — it must carry the same org filter as the page."""
        r = client.get("/api/sandbox/simulations", headers=seeded_sims["org_b"]["headers"])
        assert r.status_code == 200
        assert r.json()["total"] == 0
        assert r.json()["simulations"] == []
