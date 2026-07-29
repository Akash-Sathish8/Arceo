"""Multi-agent simulation runner — orchestrates multiple agents with dispatch.

The coordinator agent gets the initial prompt. When it calls dispatch_agent,
the runner pauses it, starts the target agent with the sub-task, captures
that agent's trace, then returns the result to the coordinator.

Each agent's tool calls go through enforcement independently.
Max dispatch depth of 3 to prevent infinite loops.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime

from sandbox.models import SimulationTrace, TraceStep, MultiAgentTrace
from sandbox.mocks.registry import MockState
from sandbox.mocks import *  # noqa: F401, F403
from sandbox.agents.executor import execute_tool_call, build_tool_definitions, parse_tool_name
from sandbox.prompts.scenarios import Scenario
from sandbox.runner import SYSTEM_PROMPTS, MAX_TURNS, MAX_TOTAL_LLM_CALLS, _SimBudget
from llm_models import SIM_MODEL, anthropic_client


DISPATCH_TOOL = {
    "name": "dispatch_agent",
    "description": "Dispatch a sub-task to a specialized agent. Use this when a task requires "
                   "expertise from another agent (e.g., dispatch to a metrics agent for analysis, "
                   "or to a remediation agent to fix an issue).",
    "input_schema": {
        "type": "object",
        "properties": {
            "target_agent_id": {
                "type": "string",
                "description": "ID of the agent to dispatch to",
            },
            "task_description": {
                "type": "string",
                "description": "What the target agent should do",
            },
            "context": {
                "type": "string",
                "description": "Relevant context from the current investigation",
            },
        },
        "required": ["target_agent_id", "task_description"],
    },
}

MAX_DISPATCH_DEPTH = 3

# MED-003 / LOW-015: the dispatch recursion is bounded in DEPTH and by cycle
# detection, but NOT in WIDTH — an agent can dispatch on every turn and each
# sub-agent can do the same. MAX_TOTAL_LLM_CALLS + _SimBudget (a shared per-request
# ceiling, imported from runner) make the blow-up impossible.


def _run_single_agent(
    agent_config: dict,
    prompt: str,
    state: MockState,
    api_key: str | None,
    agent_configs: dict[str, dict],
    multi_trace: MultiAgentTrace,
    depth: int = 0,
    max_turns: int = MAX_TURNS,
    visited_agents: frozenset[str] | None = None,
    budget: "_SimBudget | None" = None,
) -> SimulationTrace:
    """Run a single agent within a multi-agent simulation.

    If the agent calls dispatch_agent, recursively runs the target agent
    and returns the result. Depth-limited to MAX_DISPATCH_DEPTH and, across the
    whole recursion, bounded to MAX_TOTAL_LLM_CALLS model calls (MED-003).
    """
    # First (top-level) call seeds the shared budget; recursion passes it down.
    if budget is None:
        budget = _SimBudget(MAX_TOTAL_LLM_CALLS)
    agent_id = agent_config["id"]
    agent_name = agent_config["name"]

    # Track visited agents to prevent dispatch cycles (A→B→C→A)
    current_visited = (visited_agents or frozenset()) | {agent_id}

    trace = SimulationTrace(
        simulation_id=multi_trace.simulation_id,
        agent_id=agent_id,
        agent_name=agent_name,
        scenario_id=multi_trace.simulation_id,
        scenario_name=f"Multi-agent dispatch (depth={depth})",
        prompt=prompt,
    )

    # Build tool definitions + dispatch meta-tool
    tool_defs = build_tool_definitions(agent_config)
    if depth < MAX_DISPATCH_DEPTH:
        # Add dispatch tool with available agent IDs in description
        available = [aid for aid in agent_configs if aid != agent_id]
        dispatch = dict(DISPATCH_TOOL)
        dispatch["description"] += f" Available agents: {', '.join(available)}"
        tool_defs.append(dispatch)

    client = anthropic_client(api_key)

    # Determine system prompt
    agent_type = _infer_agent_type(agent_config)
    system_prompt = SYSTEM_PROMPTS.get(agent_type, SYSTEM_PROMPTS.get("ops", SYSTEM_PROMPTS["support"]))
    system_prompt += (
        f"\n\nYou are {agent_name} (id: {agent_id}). You are part of a multi-agent system. "
        f"You can dispatch sub-tasks to other agents using the dispatch_agent tool."
    )

    messages = [{"role": "user", "content": prompt}]
    step_index = len(multi_trace.unified_steps)
    # Per-agent session context for requires_prior conditions
    session_context: list[str] = []

    for turn in range(max_turns):
        # MED-003: stop before exceeding the shared total-call ceiling.
        if not budget.take():
            trace.error = f"Simulation LLM-call budget ({MAX_TOTAL_LLM_CALLS}) exhausted"
            break
        try:
            response = client.messages.create(
                model=SIM_MODEL,
                max_tokens=4096,
                system=system_prompt,
                tools=tool_defs,
                messages=messages,
            )
        except Exception as e:
            trace.status = "error"
            trace.error = f"LLM API error: {str(e)}"
            trace.completed_at = datetime.utcnow().isoformat()
            return trace

        # Record assistant message
        assistant_content = []
        for block in response.content:
            if block.type == "text":
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                assistant_content.append({
                    "type": "tool_use", "id": block.id,
                    "name": block.name, "input": block.input,
                })
        messages.append({"role": "assistant", "content": assistant_content})
        trace.messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_turn":
            break

        # Process tool calls
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            # Handle dispatch_agent meta-tool
            if block.name == "dispatch_agent":
                target_id = block.input.get("target_agent_id", "")
                task_desc = block.input.get("task_description", "")
                context = block.input.get("context", "")

                dispatch_step = TraceStep(
                    step_index=step_index,
                    tool="dispatch", action="dispatch_agent",
                    params=block.input,
                    enforce_decision="ALLOW",
                    enforce_policy=None, result=None,
                    source_agent_id=agent_id,
                    dispatch_to=target_id,
                )

                if target_id not in agent_configs:
                    dispatch_step.result = {"error": f"Unknown agent: {target_id}"}
                    dispatch_step.error = f"Unknown agent: {target_id}"
                elif depth >= MAX_DISPATCH_DEPTH:
                    dispatch_step.result = {"error": "Max dispatch depth reached"}
                    dispatch_step.error = "Max dispatch depth reached"
                elif target_id in current_visited:
                    dispatch_step.result = {"error": f"Dispatch cycle detected: {agent_id} → {target_id} already in chain"}
                    dispatch_step.error = f"Dispatch cycle detected: {target_id}"
                else:
                    # Record dispatch
                    multi_trace.dispatches.append({
                        "from_agent": agent_id, "to_agent": target_id,
                        "task": task_desc, "step_index": step_index,
                    })

                    # Run the target agent
                    full_prompt = task_desc
                    if context:
                        full_prompt += f"\n\nContext from {agent_name}: {context}"

                    sub_trace = _run_single_agent(
                        agent_config=agent_configs[target_id],
                        prompt=full_prompt,
                        state=state,
                        api_key=api_key,
                        agent_configs=agent_configs,
                        multi_trace=multi_trace,
                        depth=depth + 1,
                        max_turns=max_turns,
                        visited_agents=current_visited,
                        budget=budget,
                    )
                    multi_trace.agent_traces[target_id] = sub_trace

                    # Summarize sub-agent result
                    sub_summary = {
                        "agent": target_id,
                        "status": sub_trace.status,
                        "steps_taken": len(sub_trace.steps),
                        "last_result": sub_trace.steps[-1].result if sub_trace.steps else None,
                    }
                    dispatch_step.result = sub_summary

                trace.steps.append(dispatch_step)
                multi_trace.unified_steps.append(dispatch_step)
                step_index = len(multi_trace.unified_steps)

                tool_results.append({
                    "type": "tool_result", "tool_use_id": block.id,
                    "content": json.dumps(dispatch_step.result) if dispatch_step.result else '{"error": "dispatch failed"}',
                })
                continue

            # Normal tool call
            tool_name, action_name = parse_tool_name(block.name)
            params = block.input if isinstance(block.input, dict) else {}

            step = execute_tool_call(
                agent_id=agent_id, tool=tool_name, action=action_name,
                params=params, state=state, step_index=step_index,
                session_context=session_context,
            )
            step.source_agent_id = agent_id
            # Update per-agent session context
            if step.enforce_decision == "ALLOW":
                session_context.append(f"{tool_name}.{action_name}")
            trace.steps.append(step)
            multi_trace.unified_steps.append(step)
            step_index = len(multi_trace.unified_steps)

            tool_results.append({
                "type": "tool_result", "tool_use_id": block.id,
                "content": json.dumps(step.result) if step.result else '{"error": "Action blocked by policy"}',
            })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})
            trace.messages.append({"role": "tool_results", "content": tool_results})
        else:
            break

    trace.status = "completed"
    trace.completed_at = datetime.utcnow().isoformat()
    return trace


def _infer_agent_type(agent_config: dict) -> str:
    """Infer agent type from its tools."""
    tool_names = {t["name"] for t in agent_config.get("tools", [])}
    if "zendesk" in tool_names or "stripe" in tool_names:
        return "support"
    if "github" in tool_names or "aws" in tool_names:
        if "pagerduty" in tool_names:
            return "ops"
        return "devops"
    if "hubspot" in tool_names or "calendly" in tool_names:
        return "sales"
    return "ops"


def run_multi_simulation(
    agent_configs: dict[str, dict],
    coordinator_id: str,
    scenario: Scenario,
    api_key: str | None = None,
    max_turns: int = MAX_TURNS,
    custom_data: dict | None = None,
) -> MultiAgentTrace:
    """Run a multi-agent simulation with dispatch.

    Args:
        agent_configs: {agent_id: full_agent_config_dict}
        coordinator_id: which agent gets the initial prompt
        scenario: the scenario to run
        api_key: Anthropic API key
        max_turns: max turns per agent
        custom_data: optional custom mock data
    """
    simulation_id = uuid.uuid4().hex[:12]
    multi_trace = MultiAgentTrace(
        simulation_id=simulation_id,
        coordinator_id=coordinator_id,
    )

    state = MockState(custom_data=custom_data)

    if coordinator_id not in agent_configs:
        multi_trace.status = "error"
        multi_trace.error = f"Coordinator '{coordinator_id}' not in agent_configs"
        return multi_trace

    coordinator_trace = _run_single_agent(
        agent_config=agent_configs[coordinator_id],
        prompt=scenario.prompt,
        state=state,
        api_key=api_key,
        agent_configs=agent_configs,
        multi_trace=multi_trace,
        depth=0,
        max_turns=max_turns,
    )
    multi_trace.agent_traces[coordinator_id] = coordinator_trace

    multi_trace.status = "completed"
    multi_trace.completed_at = datetime.utcnow().isoformat()
    return multi_trace


def run_multi_simulation_dry(
    agent_configs: dict[str, dict],
    coordinator_id: str,
    scenario: Scenario,
    custom_data: dict | None = None,
) -> MultiAgentTrace:
    """Dry-run multi-agent simulation — exercises all agents sequentially without LLM."""
    simulation_id = uuid.uuid4().hex[:12]
    multi_trace = MultiAgentTrace(
        simulation_id=simulation_id,
        coordinator_id=coordinator_id,
    )

    state = MockState(custom_data=custom_data)
    step_index = 0

    for agent_id, agent_config in agent_configs.items():
        trace = SimulationTrace(
            simulation_id=simulation_id,
            agent_id=agent_id,
            agent_name=agent_config["name"],
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            prompt=f"[DRY RUN] {scenario.prompt}",
        )

        for tool in agent_config.get("tools", []):
            tool_name = tool["name"]
            for action in tool.get("actions", []):
                action_name = action["action"] if isinstance(action, dict) else action

                step = execute_tool_call(
                    agent_id=agent_id, tool=tool_name, action=action_name,
                    params={}, state=state, step_index=step_index,
                )
                step.source_agent_id = agent_id
                trace.steps.append(step)
                multi_trace.unified_steps.append(step)
                step_index += 1

        # Add a dispatch step from coordinator to each non-coordinator agent
        if agent_id != coordinator_id:
            dispatch_step = TraceStep(
                step_index=step_index,
                tool="dispatch", action="dispatch_agent",
                params={"target_agent_id": agent_id, "task_description": "Dry-run dispatch"},
                enforce_decision="ALLOW", enforce_policy=None,
                result={"agent": agent_id, "status": "completed", "steps_taken": len(trace.steps)},
                source_agent_id=coordinator_id,
                dispatch_to=agent_id,
            )
            multi_trace.unified_steps.append(dispatch_step)
            multi_trace.dispatches.append({
                "from_agent": coordinator_id, "to_agent": agent_id,
                "task": "Dry-run dispatch", "step_index": step_index,
            })
            step_index += 1

        trace.status = "completed"
        trace.completed_at = datetime.utcnow().isoformat()
        multi_trace.agent_traces[agent_id] = trace

    multi_trace.status = "completed"
    multi_trace.completed_at = datetime.utcnow().isoformat()
    return multi_trace
