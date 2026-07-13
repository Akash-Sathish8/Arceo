"""Guard against static/dynamic score-scale drift.

The static blast radius (authority/graph.py) and the dynamic trace risk score
(sandbox/analyzer.py) are meant to live on one 0-100 scale. They drifted once:
graph.py was recalibrated /240 -> /265 on 2026-07-03 while analyzer.py kept a
hard-coded /240, so dynamic scores silently read ~10% hot. Both now share
graph.SCORE_NORMALIZER; these tests fail if either side grows its own constant
back.
"""

from authority.graph import LABEL_WEIGHTS, SCORE_NORMALIZER
from sandbox.analyzer import analyze_trace
from sandbox.models import SimulationTrace, TraceStep


def _single_step_trace(tool: str, action: str) -> SimulationTrace:
    return SimulationTrace(
        simulation_id="sim-normalizer-guard",
        agent_id="agent-normalizer-guard",
        agent_name="Normalizer Guard",
        scenario_id="scenario-normalizer-guard",
        scenario_name="normalizer guard",
        prompt="synthetic single-step trace",
        steps=[
            TraceStep(
                step_index=0,
                tool=tool,
                action=action,
                params={},
                enforce_decision="ALLOW",
                enforce_policy=None,
                result={"ok": True},
            )
        ],
        status="completed",
    )


def test_analyzer_risk_score_uses_shared_normalizer():
    """A single allowed step contributes exactly its labels' weight sum to raw,
    so the reported score must be that sum normalized by graph's
    SCORE_NORMALIZER. Labels are derived the same way the analyzer derives
    them (classify_action on the bare action name), so this assertion pins
    ONLY the normalizer: under the old drifted /240 the same raw yields a
    higher score and this fails.
    """
    from authority.risk_classifier import classify_action

    report = analyze_trace(_single_step_trace("crm", "delete_record"))

    labels, _ = classify_action("delete_record", "")
    raw = sum(LABEL_WEIGHTS[label] for label in labels)
    expected = round((raw / SCORE_NORMALIZER) * 100, 1)
    assert report.risk_score == expected


def test_normalizer_is_the_calibrated_value():
    """The calibration anchor: /265 as of 2026-07-03. Changing it is a
    deliberate recalibration — update evals/calibrate_fleet.py placements and
    this pin together, never one without the other.
    """
    assert SCORE_NORMALIZER == 265.0
