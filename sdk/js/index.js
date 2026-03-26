/**
 * ActionGate SDK for JavaScript/TypeScript
 *
 * Works with Vercel AI SDK, OpenAI JS SDK, or any JS-based agent framework.
 *
 * Usage with Vercel AI SDK:
 *
 *   import { ActionGateClient, createVercelTools } from 'actiongate';
 *   import { generateText } from 'ai';
 *
 *   const gate = new ActionGateClient({ agentId: 'my-agent' });
 *   const tools = createVercelTools(gate, [
 *     { tool: 'stripe', action: 'get_customer', description: 'Look up customer' },
 *     { tool: 'stripe', action: 'create_refund', description: 'Issue refund' },
 *   ]);
 *
 *   const result = await generateText({ model, tools, prompt: '...' });
 *   const trace = await gate.getTrace();
 */

class ActionGateClient {
  constructor({ agentId, server = 'http://localhost:8000', autoSession = true }) {
    this.agentId = agentId;
    this.server = server.replace(/\/$/, '');
    this.sessionId = null;

    if (autoSession) {
      this._sessionPromise = this.startSession();
    }
  }

  async startSession() {
    const resp = await fetch(`${this.server}/mock/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: this.agentId }),
    });
    const data = await resp.json();
    this.sessionId = data.session_id;
    return this.sessionId;
  }

  async callTool(tool, action, params = {}) {
    if (!this.sessionId) await this._sessionPromise;

    const resp = await fetch(`${this.server}/mock/${tool}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': this.sessionId,
        'X-Agent-ID': this.agentId,
      },
      body: JSON.stringify(params),
    });
    return resp.json();
  }

  async getTrace() {
    if (!this.sessionId) return { steps: [], total_steps: 0 };

    const resp = await fetch(`${this.server}/mock/session/${this.sessionId}/trace`);
    return resp.json();
  }

  async registerAgent(name, description, tools) {
    const resp = await fetch(`${this.server}/api/authority/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, tools }),
    });
    return resp.json();
  }
}

/**
 * Create Vercel AI SDK compatible tools that route through ActionGate.
 *
 * @param {ActionGateClient} gate
 * @param {Array<{tool: string, action: string, description: string, parameters?: object}>} toolDefs
 * @returns {object} tools object for Vercel AI SDK's generateText/streamText
 */
function createVercelTools(gate, toolDefs) {
  const tools = {};

  for (const def of toolDefs) {
    const name = `${def.tool}__${def.action}`;
    tools[name] = {
      description: def.description || `${def.tool}.${def.action}`,
      parameters: def.parameters || {
        type: 'object',
        properties: {},
      },
      execute: async (params) => {
        const result = await gate.callTool(def.tool, def.action, params);
        return result;
      },
    };
  }

  return tools;
}

/**
 * Create OpenAI JS SDK compatible function definitions.
 * Returns { definitions, execute } where execute handles routing through ActionGate.
 */
function createOpenAITools(gate, toolDefs) {
  const definitions = toolDefs.map(def => ({
    type: 'function',
    function: {
      name: `${def.tool}__${def.action}`,
      description: def.description || `${def.tool}.${def.action}`,
      parameters: def.parameters || { type: 'object', properties: {} },
    },
  }));

  async function execute(toolCall) {
    const name = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments || '{}');

    let tool, action;
    if (name.includes('__')) {
      [tool, action] = name.split('__', 2);
    } else {
      tool = name;
      action = name;
    }

    return gate.callTool(tool, action, args);
  }

  return { definitions, execute };
}

module.exports = { ActionGateClient, createVercelTools, createOpenAITools };
