"""Prompt library (HackThePrompt): per-prompt cost and danger scoring.

Lives alongside the agent-governance product and reuses its engines: the
pricing catalog in analysis/spend_forecast.py, the detectors in redaction.py,
and the band scale in authority/graph.py. Same honesty rule as the forecast:
a number we cannot measure is labelled "heuristic"/"declared" or reported
as unavailable, never guessed silently.
"""
