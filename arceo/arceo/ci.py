"""CI output formatting and exit code handling."""

from __future__ import annotations

from arceo.scanner import ScanResult


def format_results(results: list[ScanResult], verbose: bool = False) -> str:
    """Format scan results for terminal output."""
    lines = ["", "arceo scan results:"]

    for r in results:
        lines.append(f"  {r.agent_name}:")

        if r.error:
            lines.append(f"    error: {r.error}")
            continue

        # Blast radius
        icon = "pass" if r.blast_radius_pass else "FAIL"
        threshold = f" (threshold: {r.blast_radius:.0f})" if not r.blast_radius_pass else ""
        lines.append(f"    blast_radius: {r.blast_radius:.0f}/100 {icon}{threshold}")

        # Chains
        icon = "pass" if r.chains_pass else "FAIL"
        if r.chains_detected > 0:
            chain_detail = f" ({', '.join(r.chain_names[:3])})" if r.chain_names else ""
            lines.append(f"    dangerous_chains: {r.chains_detected} {icon}{chain_detail}")
        else:
            lines.append(f"    dangerous_chains: 0 {icon}")

        # Policy violations
        icon = "pass" if r.policy_pass else "FAIL"
        if r.approval_violations:
            detail = f" ({', '.join(r.approval_violations[:3])})"
            lines.append(f"    policy_violations: {len(r.approval_violations)} {icon}{detail}")
        else:
            lines.append(f"    policy_violations: 0 {icon}")

        # Extra detail in verbose mode
        if verbose and r.report:
            if r.violations_count > 0:
                lines.append(f"    violations: {r.violations_count}")
                for v in r.violation_details[:5]:
                    lines.append(f"      - {v}")
            if r.data_flows_count > 0:
                lines.append(f"    data_flows: {r.data_flows_count}")
            if r.risk_score > 0:
                lines.append(f"    simulation_risk: {r.risk_score:.1f}/100")

    # Summary
    failed = [r for r in results if not r.passed]
    lines.append("")
    if failed:
        lines.append(f"  FAILED: {len(failed)} agent(s) exceeded policy thresholds")
    else:
        lines.append(f"  PASSED: all {len(results)} agent(s) within policy")
    lines.append("")

    return "\n".join(lines)


def format_github_comment(results: list[ScanResult]) -> str:
    """Format results as a GitHub PR comment (markdown)."""
    lines = ["## Arceo Scan Results", ""]

    all_passed = all(r.passed for r in results)

    for r in results:
        status = "PASS" if r.passed else "FAIL"
        lines.append(f"### {r.agent_name} — {status}")

        if r.error:
            lines.append(f"> Error: {r.error}")
            lines.append("")
            continue

        lines.append("")
        lines.append("| Check | Result | Detail |")
        lines.append("|-------|--------|--------|")

        br_icon = "PASS" if r.blast_radius_pass else "FAIL"
        lines.append(f"| Blast Radius | {br_icon} | {r.blast_radius:.0f}/100 |")

        ch_icon = "PASS" if r.chains_pass else "FAIL"
        chains_detail = ", ".join(r.chain_names[:3]) if r.chain_names else "none"
        lines.append(f"| Dangerous Chains | {ch_icon} | {r.chains_detected} ({chains_detail}) |")

        pv_icon = "PASS" if r.policy_pass else "FAIL"
        pv_detail = ", ".join(r.approval_violations[:3]) if r.approval_violations else "none"
        lines.append(f"| Policy Violations | {pv_icon} | {len(r.approval_violations)} ({pv_detail}) |")

        lines.append("")

    if all_passed:
        lines.append("**All agents passed policy checks.**")
    else:
        failed = [r.agent_name for r in results if not r.passed]
        lines.append(f"**FAILED:** {', '.join(failed)} exceeded policy thresholds.")

    return "\n".join(lines)


def get_exit_code(results: list[ScanResult]) -> int:
    """Return 0 if all passed, 1 if any failed."""
    return 0 if all(r.passed for r in results) else 1
