"""Tests for the chain detector — risk-label transition detection."""

import pytest
from authority.chain_detector import detect_chains
from authority.parser import AgentConfig, ToolDef


def _make_agent(tools_actions: dict[str, list[str]]) -> AgentConfig:
    """Helper: create an AgentConfig from {tool_name: [action1, action2]}."""
    tools = []
    for name, actions in tools_actions.items():
        tools.append(ToolDef(name=name, service=name.title(), description="", actions=actions))
    return AgentConfig(id="test-agent", name="Test Agent", description="", tools=tools)


class TestDetectChains:
    def test_pii_exfiltration_chain(self):
        agent = _make_agent({
            "stripe": ["get_customer"],  # touches_pii
            "email": ["send_email"],      # sends_external
        })
        result = detect_chains(agent)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "pii-exfil" in chain_ids

    def test_no_chains_for_truly_safe_agent(self):
        """An agent with only read-only actions on a single safe service."""
        from authority.action_mapper import MappedAction
        agent = _make_agent({"internal": ["read_config", "check_status"]})
        overrides = {
            "internal": {
                "read_config": MappedAction(tool="internal", service="Internal", action="read_config",
                                            description="", risk_labels=[], reversible=True),
                "check_status": MappedAction(tool="internal", service="Internal", action="check_status",
                                             description="", risk_labels=[], reversible=True),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        assert len(result.flagged_chains) == 0

    def test_pii_to_delete_chain(self):
        agent = _make_agent({
            "salesforce": ["query_contacts"],  # touches_pii
            "stripe": ["delete_customer"],     # deletes_data
        })
        result = detect_chains(agent)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "pii-delete" in chain_ids

    def test_cascading_prod_changes(self):
        # Two distinct production actions SHOULD trigger prod-prod
        agent = _make_agent({
            "github": ["merge_pull_request", "trigger_workflow"],
        })
        result = detect_chains(agent)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "prod-prod" in chain_ids

    def test_safe_read_only_agent_no_chains_with_overrides(self):
        """With action_overrides, only the agent's actual actions are considered."""
        from authority.action_mapper import MappedAction
        agent = _make_agent({"github": ["list_repos", "get_pull_request"]})
        overrides = {
            "github": {
                "list_repos": MappedAction(tool="github", service="GitHub", action="list_repos",
                                           description="", risk_labels=[], reversible=True),
                "get_pull_request": MappedAction(tool="github", service="GitHub", action="get_pull_request",
                                                  description="", risk_labels=[], reversible=True),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        assert len(result.flagged_chains) == 0

    def test_prod_to_delete_chain(self):
        agent = _make_agent({
            "aws": ["terminate_instance", "delete_snapshot"],
        })
        result = detect_chains(agent)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "prod-delete" in chain_ids

    def test_action_overrides_used(self):
        from authority.action_mapper import MappedAction

        agent = _make_agent({"custom_tool": ["do_stuff", "send_stuff"]})
        overrides = {
            "custom_tool": {
                "do_stuff": MappedAction(tool="custom_tool", service="Custom", action="do_stuff",
                                         description="", risk_labels=["touches_pii"], reversible=True),
                "send_stuff": MappedAction(tool="custom_tool", service="Custom", action="send_stuff",
                                           description="", risk_labels=["sends_external"], reversible=False),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "pii-exfil" in chain_ids

    def test_same_label_needs_two_distinct_actions(self):
        """money-money chain requires 2 distinct moves_money actions."""
        from authority.action_mapper import MappedAction
        agent = _make_agent({"pay": ["charge"]})
        overrides = {
            "pay": {
                "charge": MappedAction(tool="pay", service="Pay", action="charge",
                                       description="", risk_labels=["moves_money"], reversible=True),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "money-money" not in chain_ids

    def test_chained_financial_with_two_actions(self):
        """money-money chain triggers with 2 distinct moves_money actions."""
        from authority.action_mapper import MappedAction
        agent = _make_agent({"pay": ["charge", "refund"]})
        overrides = {
            "pay": {
                "charge": MappedAction(tool="pay", service="Pay", action="charge",
                                       description="", risk_labels=["moves_money"], reversible=True),
                "refund": MappedAction(tool="pay", service="Pay", action="refund",
                                       description="", risk_labels=["moves_money"], reversible=True),
            }
        }
        result = detect_chains(agent, action_overrides=overrides)
        chain_ids = [fc.chain.id for fc in result.flagged_chains]
        assert "money-money" in chain_ids
