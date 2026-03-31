"""@arceo.monitor — the main decorator."""

from __future__ import annotations

import sys
import functools

from arceo.models import ArceoTrace
from arceo.tracing.context import set_trace, clear_trace
from arceo.analysis.risk import detect_chains_local
from arceo.report import print_report


class ArceoSecurityError(Exception):
    """Raised when block_on_critical=True and critical chains found."""
    pass


def monitor(
    api_url="http://localhost:8000",
    api_key="",
    local_only=False,
    auto_detect=True,
    risk_threshold=60.0,
    block_on_critical=False,
    verbose=True,
):
    """Decorator that monitors tool calls and analyzes risk.

    @monitor(verbose=True)
    def my_agent(prompt):
        ...
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            framework = _detect_framework() if auto_detect else ""
            trace = ArceoTrace(agent_name=fn.__name__, framework=framework)

            # Capture input prompt
            if args and isinstance(args[0], str):
                trace.input_prompt = args[0]
            elif "prompt" in kwargs:
                trace.input_prompt = str(kwargs["prompt"])

            # Set context for @tool calls
            token = set_trace(trace)

            # Install framework interceptors
            patches = _install_patches(trace, framework)

            try:
                result = fn(*args, **kwargs)
                if result is not None:
                    trace.output = str(result)[:500]
                return result
            except ArceoSecurityError:
                raise
            except Exception as e:
                trace.output = "ERROR: %s" % str(e)
                raise
            finally:
                _remove_patches(patches)
                clear_trace(token)
                trace.finalize()

                # Collect schemas from vanilla tools
                if not trace.available_tools:
                    from arceo.frameworks.vanilla import get_registered_schemas
                    trace.available_tools = get_registered_schemas()

                # Local analysis
                chains = detect_chains_local(trace.tool_calls)

                # Backend analysis
                backend_data = None
                if not local_only and api_url and trace.tool_calls:
                    from arceo.client import ArceoClient
                    client = ArceoClient(api_url=api_url, api_key=api_key)
                    backend_data = client.analyze(trace)

                if verbose and trace.tool_calls:
                    print_report(trace, chains=chains, backend_data=backend_data)
                elif verbose and not trace.tool_calls:
                    print("Arceo: No tool calls detected.", file=sys.stderr)

                # Attach for programmatic access
                wrapper._last_trace = trace
                wrapper._last_chains = chains
                wrapper._last_backend = backend_data

                # Block on critical
                if block_on_critical and chains:
                    critical = [c for c in chains if c.get("severity") == "critical"]
                    if critical:
                        names = ", ".join(c["chain_name"] for c in critical)
                        raise ArceoSecurityError("Critical chains: %s" % names)

        wrapper._last_trace = None
        wrapper._last_chains = None
        wrapper._last_backend = None
        return wrapper
    return decorator


def analyze_local(tools):
    """Run local analysis without decorator. No backend needed.

    tools: [{"name": "stripe", "actions": ["get_customer", "create_refund"]}]
    """
    from arceo.models import ArceoToolCall
    from arceo.analysis.risk import infer_risk, infer_verb

    # Build synthetic tool calls to get chain detection
    calls = []
    for t in tools:
        tool_name = t.get("name", "unknown")
        for action in t.get("actions", []):
            a_name = action if isinstance(action, str) else action.get("name", "")
            hints, read_only = infer_risk(tool_name, a_name)
            calls.append(ArceoToolCall(
                tool_name=tool_name, action_name=a_name,
                inferred_risk_hints=hints, is_read_only=read_only,
                inferred_verb=infer_verb(a_name),
            ))

    chains = detect_chains_local(calls)

    trace = ArceoTrace(agent_name="local_analysis")
    trace.tool_calls = calls
    trace.finalize()

    print_report(trace, chains=chains)
    return {"trace": trace, "chains": chains}


def _detect_framework() -> str:
    m = sys.modules
    if "langchain" in m or "langchain_core" in m:
        return "langchain"
    if "crewai" in m:
        return "crewai"
    if "agents" in m:
        return "openai_agents"
    if "openai" in m:
        return "openai"
    if "anthropic" in m:
        return "anthropic"
    return "vanilla"


def _install_patches(trace, framework):
    patches = []

    # OpenAI
    from arceo.frameworks.openai_sdk import patch_openai
    patches.extend(patch_openai(trace))

    # Anthropic
    from arceo.frameworks.anthropic_sdk import patch_anthropic
    patches.extend(patch_anthropic(trace))

    return patches


def _remove_patches(patches):
    for obj, attr, original in patches:
        setattr(obj, attr, original)
