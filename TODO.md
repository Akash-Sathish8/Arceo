# ActionGate — TODO

## Done this session
- [x] README with setup, architecture, SDK quickstart for 9 frameworks
- [x] SDK README with framework support table
- [x] Onboarding: templates (Support, DevOps, Sales) + custom agent + MCP connect
- [x] LLM simulation button in sandbox UI ("Run with LLM")
- [x] Mock session listing endpoint (GET /mock/sessions)
- [x] Better auto-generated scenarios with specific mock data references
- [x] Authority graph works for custom tools (action_overrides wired through)
- [x] JS SDK tested in Node (sessions, tool calls, traces, Vercel tools)
- [x] MCP auto-discovery: POST /api/authority/agents/connect/mcp connects to live server, pulls tools, registers agent
- [x] MCP connect UI on dashboard (onboarding + main view)

## Priority 1: Visual verification (do first)
- [ ] Open every page in browser and click through
- [ ] Fix any CSS/layout bugs (onboarding templates, MCP connect form, agent creation, sandbox scenarios, simulation detail, before/after comparison)
- [ ] Full demo flow: login → template → dashboard → agent detail → sandbox → run → results → apply policies → re-run → comparison → full report

## Priority 2: Tests
- [ ] Backend: risk_classifier, analyzer, chain_detector unit tests
- [ ] Backend: API tests for register, enforce, simulate, apply-policy, connect-mcp
- [ ] SDK: ActionGateClient, wrap_tools
- [ ] Frontend: smoke test that every page renders

## Priority 3: Security
- [ ] SHA256 → bcrypt for passwords
- [ ] CORS: set specific origin, not *
- [ ] Rate limiting on enforce and mock endpoints
- [ ] .env file for ANTHROPIC_API_KEY, add .env to .gitignore
- [ ] ROTATE YOUR ANTHROPIC API KEY (exposed in chat)

## Priority 4: Demo polish
- [ ] Deduplicate enforce logic (3 copies in main.py)
- [ ] Frontend error boundaries
- [ ] Label dry-run vs LLM results clearly in the UI
- [ ] Loading states on agent creation form
- [ ] Execution log: distinguish mock sessions from simulations

## Priority 5: Product depth
- [ ] Let companies upload custom test data (not just Jane Doe / Bob Smith)
- [ ] Integration guide / docs site for each SDK framework
- [ ] Webhook/Slack notifications on violations
- [ ] Export simulation reports as PDF
- [ ] Multi-user with team isolation
- [ ] PostgreSQL migration

## Priority 6: Uncommitted work
- [ ] Commit and push all changes to features branch
- [ ] Review diff for secrets before pushing
- [ ] Update CLAUDE.md with new endpoints
