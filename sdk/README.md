# ActionGate SDK

Test your AI agent's tools in a sandbox. Wrap any framework — every tool call goes through ActionGate's enforcement and mock APIs.

## Install

```bash
pip install -e .
```

## Supported Frameworks

| Framework | Import | Status |
|-----------|--------|--------|
| LangChain | `from actiongate import wrap_tools` | Tested with LLM |
| Anthropic SDK | `from actiongate.frameworks.anthropic_sdk import run_agent_loop` | Tested with LLM |
| OpenAI SDK | `from actiongate.frameworks.openai_sdk import execute_tool_calls` | Tested |
| CrewAI | `from actiongate.frameworks.crewai import wrap_crewai_tools` | Tested |
| AutoGen | `from actiongate.frameworks.autogen import create_autogen_functions` | Tested |
| LlamaIndex | `from actiongate.frameworks.llamaindex import create_llamaindex_tools` | Tested |
| Haystack | `from actiongate.frameworks.haystack import create_haystack_tools` | Tested |
| MCP | `from actiongate.frameworks.mcp import ActionGateMCPProxy` | Tested |
| Vercel AI SDK (JS) | `require('actiongate')` — see `sdk/js/` | Written |

## How it works

1. You create an `ActionGateClient` with your agent's ID
2. You wrap your tools (or create new ones through the framework wrapper)
3. Every tool call now goes to `POST /mock/{tool}/{action}` on ActionGate's server
4. ActionGate checks enforcement policies (BLOCK / REQUIRE_APPROVAL / ALLOW)
5. If allowed, returns fake data from the mock API
6. The full trace is captured for analysis

Your agent doesn't know the difference — it thinks it's calling real APIs.

## Quick Example

```python
from actiongate import ActionGateClient, wrap_tools
from langchain_core.tools import tool

@tool
def stripe__get_customer(customer_id: str) -> str:
    """Look up a customer."""
    pass  # ActionGate intercepts this

gate = ActionGateClient(agent_id="my-agent")
wrapped = wrap_tools([stripe__get_customer], gate)

result = wrapped[0].invoke({"customer_id": "cust_1042"})
# Returns: {"customer": {"id": "cust_1042", "name": "Jane Doe", ...}}

trace = gate.get_trace()
# Shows every tool call, enforce decision, and result
```
