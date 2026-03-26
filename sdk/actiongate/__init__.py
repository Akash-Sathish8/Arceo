"""ActionGate SDK — wrap your AI agent's tools to test them in a sandbox.

Supports: LangChain, Anthropic SDK, OpenAI SDK, CrewAI, AutoGen,
LlamaIndex, Haystack, MCP clients. JavaScript/Vercel AI SDK in sdk/js/.

Usage:
    from actiongate import ActionGateClient, wrap_tools

    gate = ActionGateClient(agent_id="my-agent")
    wrapped = wrap_tools(my_langchain_tools, gate)

Framework-specific:
    from actiongate.frameworks.anthropic_sdk import run_agent_loop
    from actiongate.frameworks.openai_sdk import execute_tool_calls
    from actiongate.frameworks.crewai import wrap_crewai_tools
    from actiongate.frameworks.autogen import create_autogen_functions
    from actiongate.frameworks.llamaindex import create_llamaindex_tools
    from actiongate.frameworks.haystack import create_haystack_tools
    from actiongate.frameworks.mcp import ActionGateMCPProxy
"""

from actiongate.client import ActionGateClient
from actiongate.wrapper import ActionGateTool, wrap_tool, wrap_tools

__all__ = ["ActionGateClient", "ActionGateTool", "wrap_tool", "wrap_tools"]
