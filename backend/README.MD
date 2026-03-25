*Backend Outline*

  Auth system (JWT login, token verification)
  - POST /api/auth/login — takes email + password, checks against the database, returns a JWT token
  - GET /api/auth/me — takes a token, returns the logged-in user's info
  - Tokens expire after 24 hours
  - Every protected endpoint checks the Authorization: Bearer <token> header
  - If no token or expired token, returns 401 Unauthorized
  - Passwords stored as SHA-256 hashes

  SQLite database **change to postgressql when deploying**
  - users table — id, email, password hash, name, role (viewer or admin), created timestamp
  - agents table — id, name, description, created/updated timestamps
  - agent_tools table — links tools to agents, stores tool name, service name, description
  - tool_actions table — links actions to tools, stores action name, description, risk labels (JSON array), reversible flag
  - policies table — links enforcement rules to agents, stores action pattern, effect, reason, who created it, when
  - audit_log table — stores user id, email, what they did, which resource, detail text, timestamp
  - execution_log table — stores agent id, tool, action, status (EXECUTED/BLOCKED/PENDING_APPROVAL), which policy matched, detail, timestamp
  - Auto-creates all tables on first startup
  - Seeds sample data if the database is empty

  Authority Engine
  - parser.py — defines the structure of an agent config (agent has tools, tools have actions)
  - parser.py — stores 3 sample agent configs with realistic tool setups across 11 services
  - action_mapper.py — catalogs 80+ actions across Stripe, Zendesk, Salesforce, SendGrid, GitHub, AWS, Slack, PagerDuty, HubSpot, Gmail, Calendly
  - action_mapper.py — every action has a description, a list of risk labels, and a reversible/irreversible flag
  - action_mapper.py — 5 risk labels: moves_money, touches_pii, deletes_data, sends_external, changes_production
  - graph.py — builds a directed graph per agent: agent node → tool nodes → action nodes → risk label nodes
  - graph.py — calculates blast radius score (0-100) using weighted formula: money actions worth 15 points, delete worth 12, production changes worth 10, PII worth 8, external sends worth 6, irreversible worth 5
  - graph.py — serializes the graph to JSON so the frontend can draw it
  - chain_detector.py — defines 10 dangerous 2-step patterns (e.g. "reads PII then sends externally")
  - chain_detector.py — for each agent, checks if it has actions matching both steps of each pattern
  - chain_detector.py — returns which specific actions form each chain (e.g. salesforce.query_contacts → email.send_email)

  CRUD API
  - POST /api/authority/agents — creates a new agent with tools and actions, auto-generates an ID from the name
  - PUT /api/authority/agent/{id} — updates an agent's name, description, tools, and actions (deletes old tools and re-inserts)
  - DELETE /api/authority/agent/{id} — deletes an agent and all its tools, actions, and policies (cascading delete)
  - GET /api/authority/agents — lists all agents with blast radius scores, chain counts, and tool names
  - GET /api/authority/agent/{id} — returns full detail: graph, blast radius, chains, recommendations, policies, execution log

  Enforcement engine
  - POST /api/enforce — the endpoint agents call before executing any action
  - Takes agent_id, tool name, and action name
  - Checks all policies for that agent
  - Supports exact match (stripe.create_refund), tool wildcard (stripe.*), and action wildcard (*.delete_*)
  - Returns BLOCK — action is denied, agent gets an error message
  - Returns REQUIRE_APPROVAL — action is paused, needs human sign-off
  - Returns ALLOW — either a policy explicitly allows it or no policy matches (default allow)
  - Logs every enforcement decision to the execution log automatically

  Audit logging
  - Records LOGIN — when a user signs in
  - Records LIST_AGENTS — when someone views the dashboard
  - Records VIEW_AGENT — when someone opens an agent detail page
  - Records CREATE_AGENT — when an agent is added, includes agent name and tool count
  - Records UPDATE_AGENT — when an agent is modified
  - Records DELETE_AGENT — when an agent is removed, includes the agent's name
  - Records CREATE_POLICY — when an enforcement rule is added, includes the effect and pattern
  - Records DELETE_POLICY — when an enforcement rule is removed
  - Every entry stores who did it (user id + email), what they did, which resource, and when

  Execution tracking
  - Logs every action an agent attempts through the enforce endpoint
  - Stores: which agent, which tool, which action, what happened (EXECUTED/BLOCKED/PENDING_APPROVAL)
  - Stores which policy caused a block (if any)
  - Stores a detail string explaining what happened
  - GET /api/executions — returns the last 100 entries across all agents
  - GET /api/executions/{agent_id} — returns the last 50 entries for one agent
  - Agent detail page also shows that agent's recent executions

  3 sample agents seeded
  - Customer Support Agent — Zendesk (8 actions), Stripe (8 actions), Salesforce (8 actions), SendGrid (4 actions) = 28 total, blast radius 79.7
  - DevOps Agent — GitHub (9 actions), AWS (10 actions), Slack (5 actions), PagerDuty (6 actions) = 30 total, blast radius 75.3
  - Sales Agent — HubSpot (11 actions), Slack (4 actions), Gmail (7 actions), Calendly (5 actions) = 28 total, blast radius 66.3

  8 sample policies
  - Support agent: REQUIRE_APPROVAL on stripe.create_refund (refunds over $50)
  - Support agent: BLOCK on stripe.create_charge (can't charge cards)
  - Support agent: BLOCK on stripe.delete_customer (can't delete customers)
  - Support agent: BLOCK on salesforce.delete_record (can't delete CRM records)
  - DevOps agent: REQUIRE_APPROVAL on aws.terminate_instance (needs SRE approval)
  - DevOps agent: REQUIRE_APPROVAL on aws.delete_snapshot (needs backup verification)
  - Sales agent: BLOCK on hubspot.delete_contact (can't delete contacts)
  - Sales agent: REQUIRE_APPROVAL on gmail.send_email (outbound emails need manager review)

  16 sample execution logs
  - 6 support agent actions: 4 executed (customer lookup, contact query, email send, ticket update), 2 blocked (refund, charge)
  - 6 devops agent actions: 4 executed (PR fetch, merge, deploy trigger, Slack notification), 1 blocked (instance termination), 1 executed (security group update)
  - 4 sales agent actions: 3 executed (contact search, email outreach, meeting link), 1 blocked (contact deletion)

  Demo user
  - Email: admin@actiongate.io
  - Password: admin123
  - Role: admin
  - Auto-created when the database is first initialized


*Frontend: Nikhil give skeleton*
