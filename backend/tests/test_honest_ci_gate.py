"""Phase-6 PR-2: the CI scan gate fails on DISTRUST, not on raw power.

An honest, fully-classified, legitimately-powerful agent (a real refund bot)
must NOT fail the build — teams that see honest agents fail learn to ignore the
gate. We fail only on signals the scanner genuinely can't vouch for: a critical
action-chain, opaque/unclassifiable capability (>25%), or arbitrary code exec.

These stub `_score_in_memory` (the Haiku extraction, unavailable in tests) with
canned agent results so the assertions target the verdict logic itself.
"""

from __future__ import annotations

import pytest

import main


def _agent(name, *, score, total, unclassified=0, executes_code=False, critical_chains=0):
    """A canned _score_in_memory result matching the real output shape."""
    labels = ["executes_code"] if executes_code else ["moves_money"]
    chains = [{"id": f"c{i}", "name": "PII exfiltration", "description": "reads PII then sends it out",
               "severity": "critical", "steps": [], "risk_tags": [], "matching_actions": []}
              for i in range(critical_chains)]
    return {
        "name": name,
        "file": f"{name}.py",
        "blast_radius": {
            "score": score,
            "coverage": {"totalActions": total, "unclassifiedActions": unclassified},
        },
        "chains": chains,
        "tools": [{"name": "svc", "actions": [
            {"name": "do", "risk_labels": labels, "reversible": False,
             "classification_source": "opaque" if unclassified else "catalog"}
        ]}],
    }


@pytest.fixture()
def scan(client, roles, monkeypatch):
    """Return a helper that POSTs to /api/scan with a valid key, using a stubbed
    extractor that yields the given canned agent(s)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")  # pass the 503 guard
    admin = roles["admin"]
    key = client.post("/api/keys", headers=admin["headers"],
                      json={"name": "ci"}).json()["key"]

    def run(agents):
        it = iter(agents)
        monkeypatch.setattr(main, "_score_in_memory", lambda path, content, cli: next(it, None))
        files = [{"path": a["file"], "content": "x"} for a in agents]
        r = client.post("/api/scan", headers={"X-API-Key": key},
                        json={"files": files, "threshold": 60})
        assert r.status_code == 200, r.text
        return r.json()["summary"]

    return run


def test_honest_powerful_agent_warns_not_fails(scan):
    # A real refund bot: high blast radius, everything classified, no critical
    # chain, no code exec. Powerful ≠ untrustworthy — WARN, don't break the build.
    s = scan([_agent("refund-bot", score=78, total=6, unclassified=0)])
    assert s["verdict"] == "warn"
    assert s["fail_reasons"] == []


def test_code_execution_fails(scan):
    s = scan([_agent("shell-runner", score=40, total=3, executes_code=True)])
    assert s["verdict"] == "fail"
    assert any("executes_code" in r or "code/shell" in r for r in s["fail_reasons"])


def test_opaque_capability_fails(scan):
    # 3 of 4 actions unclassifiable → the score can't be trusted → fail.
    s = scan([_agent("mystery", score=20, total=4, unclassified=3)])
    assert s["verdict"] == "fail"
    assert any("unclassifiable" in r or "opaque" in r for r in s["fail_reasons"])


def test_critical_chain_fails(scan):
    s = scan([_agent("leaky", score=50, total=4, critical_chains=1)])
    assert s["verdict"] == "fail"
    assert any("chain" in r for r in s["fail_reasons"])


def test_clean_low_agent_passes(scan):
    s = scan([_agent("notetaker", score=12, total=3, unclassified=0)])
    assert s["verdict"] == "pass"
    assert s["fail_reasons"] == []


def test_low_opaque_below_threshold_does_not_fail(scan):
    # 1 of 5 unclassified (20%) is under the 25% bar — not enough to fail on its own.
    s = scan([_agent("mostly-known", score=15, total=5, unclassified=1)])
    assert s["verdict"] == "pass"
    assert s["fail_reasons"] == []
