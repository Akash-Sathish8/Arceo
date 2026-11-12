# Arceo Prompts rework: send to your agent, match before you add, no scores

## Context
Arceo Prompts lives in the worktree `~/ActionGate-prompts` on branch `feat/prompt-library`, which has a lot of uncommitted work. The main repo is `~/ActionGate`, with notes in `~/ActionGate/brain`. Every screen today is built around Arceo grading prompts: a danger score on every card, test runs, Compare with votes and an Elo leaderboard, and the website "score box".

**What customers asked for:**
1. Don't focus on us rating prompts.
2. Make it simple for non-technical users.
3. Show similar prompts.
4. Click a prompt and have it sent to your coding agent.

**Akash's decisions:**
- Hide scores but keep plain warnings. Backend scoring code stays and is just not shown.
- Cost stays.
- Support every agent we can find.
- Also build an MCP server.
- Add coding-agent starters and **many more prompts**, about 250 in total.
- **When you add a prompt, match it against similar ones before you ever run it**, using a carefully designed algorithm.

**How it gets built.** Ultracode: a multi-agent workflow at high effort, with no token budget limit.

**A limit to state up front.** Cursor, Claude Code, Lovable, Windsurf and Replit links all open with the prompt typed in and wait for the user to press Enter. The vendors do this on purpose, for security. So for links, "automatic" means one click, then Enter. The MCP server is the hands-free route: the agent fetches what was sent. Even then, the user tells their agent once ("run my Arceo prompt", or `/mcp__arceo__sent`), because nothing can push into an agent session that's already running.

---

## 1. The prompt-match algorithm (new `backend/prompts/similarity.py`)
**Goal.** Someone pastes or types a prompt. Before they save or run it, we tell them:
- **"Already in the library: 'X'"**: same job.
- **"Close to 'X'. Yours also asks for: …"**: a variant.
- **"Related"**: shown quietly in a row, never as an interruption.

It must hold up when the person pastes the prompt *with their real content already filled in* (an actual email or error message instead of `{{email}}`). It must also hold up against rewording, typos, different blank names, the safety boilerplate that many prompts share, and other prompts in the same category that do a different job. It needs no new paid provider, gives the same answer every time, and costs nothing per keystroke.

### Stage 1: canonicalize: `canonical(prompt) -> Canon`
1. Unicode NFKC, lowercase, straighten quotes, collapse whitespace.
2. **Blanks.** Each `{{name}}` becomes the token `§blank`. Blank names become a *concept set*: split snake/camelCase, singularize, map through the lexicon. So `customer_email`, `email_text` and `message` all become `c:message`.
3. **Fences.** Drop tags and fences that wrap blanks (`<email>{{email}}</email>`, ``` blocks, quoted blocks). Reuse `danger._is_delimited` logic.
4. **Boilerplate.** Remove sentences matching `danger._DATA_RULE` / `_REVIEW_RULE`, which seed prompts and Fix-it-for-me add everywhere, plus a short stop-phrase list ("please", "you are a helpful assistant", "act as an expert"). Otherwise safety text makes every prompt look alike.
5. **Payload extraction.** This handles pasting with real content. Split the text into blocks. A block counts as *payload* if any of these hold:
   - it's fenced, tagged or quoted
   - it follows a line ending in ":" ("Here's the email:", "Error:") and is 25 words or more, or spans several lines
   - it looks like content rather than instructions:
     - an email: greeting and sign-off, or `From:`/`Subject:` lines
     - an error: stack trace, `Traceback`, `at x (file:line)`, log timestamps
     - code: high density of `;{}=()`
     - lines that are only URLs

   Each payload block becomes `§blank`, and its *kind* (message / error / code / notes / document) joins the blank-concept set. A pasted email therefore lines up with a library template's `{{email}}`, both in the text and in the blank set.
6. **Numbers.** Number words become digits, then `§num` in the main text. A separate *shape* channel keeps format (bullets / table / list / steps / email / code / json), count (3 vs 5) and a length bucket. "3 bullets" still matches "5 bullets", and the difference can be named.
7. **Tokenize.**
   - Match multi-word lexicon phrases longest-first: "bullet points" → `c:bullets`; "sign up page" → `c:signup c:page`.
   - Run the Snowball English stemmer on everything else, using `snowballstemmer`, a tiny pure-Python library.
   - Drop stopwords.
8. Output: `tokens`, instruction text, blank concepts, shape, and `hash = sha256(tokens)`.

**Lexicon** (`backend/prompts/similarity_lexicon.yaml`, data, not code): about 250 synonym groups for this domain. Each has a plain-language display label. Examples:
- summarize ≈ sum up ≈ condense ≈ tl;dr ≈ boil down
- bullets ≈ bullet points ≈ key points
- email ≈ message ≈ note
- fix ≈ debug ≈ resolve ≈ not working
- sign up ≈ register ≈ create account
- phone ≈ mobile ≈ responsive
- dark mode ≈ dark theme
- rewrite ≈ reword ≈ rephrase
- friendly ≈ warm; formal ≈ professional

This is the main tool against rewording, and the eval loop (Stage 5) grows it.

### Stage 2: index (`SimilarityIndex`, kept in memory per process)
- **Rebuild trigger.** Rebuild when `(count, max(updated_at))` of prompts changes; checking that is one cheap query per request.
- **IDF.** Compute it from public, published prompts only (the seed library is the background corpus). No other org's private text ever affects weights, and unseen terms get the maximum IDF.
- **Stored per prompt:**
  - word unigram+bigram TF-IDF (sublinear tf, L2-normalized)
  - char 3–5-gram TF-IDF within word boundaries, which catches typos and word-form changes ("summarise" vs "summary")
  - a 3-word shingle set
  - a meta vector (title + description + use_case)
  - an inverted index over concept and stem terms

### Stage 3: candidates
- Take the union of the posting lists for the query's 12 highest-IDF terms, plus any exact-hash hit.
- **Visibility filter, same as `store.list_prompts`:** the viewer's own org, or public and published.
- **Exclusions:** the prompt itself, and its fork parent and children. Those get labeled "Your copy of X" instead of interrupting.
- Keep the top 40 by word cosine. Under about 20k prompts this stays well within 50 ms. Past that, switch candidate selection to MinHash-LSH (documented, not built).

### Stage 4: score each (new prompt q, candidate c)
Features:

| # | Feature |
|---|---|
| f1 | exact canonical hash match |
| f2 | word TF-IDF cosine |
| f3 | char n-gram cosine |
| f4 | 3-shingle Jaccard |
| f5 | **containment** \|S_q∩S_c\|/\|S_c\|: how much of the existing prompt sits inside the new one, which catches "copied and extended" |
| f6 | blank-concept Jaccard, plus an "both have no blanks" indicator |
| f7 | meta cosine (q's title and description if present, else its text, vs c's title and description) |
| f8 | shape agreement: format match minus count mismatch, length bucket |
| f9 | same category |
| f10 | log length ratio |

`score = σ(w·f + b)`. The weights and three thresholds live in `similarity_weights.json`. They're fit by a small pure-Python L2 logistic regression (deterministic) on the eval set's fit split, and ship with hand-set defaults until that fit runs.

**Levels:**
- **same:** f1, or (score ≥ T_same **and** at most one extra *salient* concept on each side). Salient means high-IDF concepts, not `§blank` or `§num`.
- **close:** score ≥ T_close.
- **related:** score ≥ T_related. Shown only in the Similar row.

**Plain-language explanation**, built from lexicon labels:
- "Both: summarize · email · bullets"
- "Yours also: draft a reply"
- "Theirs also: deadline"
- shape differences, e.g. "yours: 5 bullets, theirs: 3"

### Stage 5: calibrate against a labeled eval set (`backend/tests/eval/prompt_similarity_cases.yaml`)
Built from the *final* seed corpus, about 400 queries. Queries are never in the corpus.
- **filled:** the seed body rendered with its own samples via `template.render`, with natural lead-ins ("here's my email:"). Expected: **same**.
- **paraphrase:** same job, different words. Expected: **same**.
- **extended / trimmed:** one or two requirements added or removed. Expected: **close**.
- **hard negative:** same category, overlapping words, different job. Expected: must **not** be close or same.
- **novel:** a job not in the corpus. Expected: none.

The fit/holdout split is 70/30 *by seed prompt*, so nothing leaks between them. `python -m prompts.similarity_fit` fits weights, picks thresholds (T_same at ≥0.97 precision, T_close ≥0.85, T_related ≥0.6 on the fit split), prints a metrics table, and writes the JSON.

**Holdout targets, enforced in a test:**
- "same": precision ≥ 0.95 and recall ≥ 0.85. Never tell someone wrongly that theirs already exists.
- Any match on paraphrase, filled and extended: recall ≥ 0.90.
- Hard negatives wrongly marked close or same: ≤ 5%.
- Top-1 MRR ≥ 0.90.

If a target is missed, iterate: grow the lexicon, adjust payload rules, refit. Results are reported per case type.

### Stage 6: AI second opinion (optional; on Save only, never while typing)
**When it runs:** only when the top match falls in the uncertain band [T_close, T_same) and an Anthropic key is available, under the same policy and client as `ai_check.py` (`llm_models.anthropic_client`, FAST_MODEL).

**What it does:** asks Haiku, with both prompts fenced as data, for `{same_job: yes|partly|no, difference: one plain sentence}`. The answer can promote close to same or demote close to related, and its sentence replaces the term-difference text.
- Cached by `(hash_q, hash_c)`.
- Stubbed in tests.
- Tracked as a separate eval number. It doesn't run in CI.

### Where matching shows up
1. **Adding a prompt (the main case).** On `/prompts/new` and in the paste-first flow:
   - **While typing.** A live check runs (500 ms debounce, once there are 8+ content words) and shows a small card under the text box: [Use that one] [Send it now] [Keep writing mine].
   - **On Save.** If the top match is **same** and hasn't been dismissed, a sheet appears: "This one's already in the library" [Use that one] [Save mine anyway]. A **close** match only gets a non-blocking note.
   - **Your own prompts.** If the match is a prompt the user already owns, the message is "You already have this one" [Open mine].
2. **Similar prompts row:** a row of up to 6 on the detail page and the public page.
3. **Search.** The library search box and MCP `search_prompts` run the same canonicalization on the query, rank results, and merge in today's ILIKE hits. So "summarize email" finds "Client email to 3 bullets".
4. **Seed hygiene.** A test requires that no two seed prompts are close or above.
5. **API.** `POST /api/prompts` also returns `matches` (top 3 that are close or better), so API and MCP callers see them.

---

## 2. Hide ratings, keep plain warnings
**Warnings component.** New `components/prompts/Warnings.tsx` renders nothing unless `danger_summary.reasons` includes high or critical items or there are `publish_blockers`. When it does render, it shows one plain sentence per item, plus the existing "Fix it for me" and "Doesn't apply to me". No ring, number, band or "tested" label. It replaces `DangerPanel` in `PromptDetail`, `PublicPrompt`, and `PromptWorkflowBuilder`'s "Is it safe?" card.

**Removed from the UI:**
- `DangerBadge` on library cards and the danger-colored card border (`PromptLibrary.tsx:40-72`)
- `DangerBadge` on `CreatorProfile` and `PromptWorkflows`
- the "Safest first" sort and the "Safe ones only" filter
- `QaPanel`
- the "Compare versions" button
- the Compare entries in the sidebar and TopBar
- "Comparison wins"

The code stays, and the routes stay reachable by URL so old share links still work.

**Sharing:**
- Drop the "rated critical" checkbox.
- Backend `publish_prompt` (`router.py:316`) no longer requires `acknowledge_risk` and drops the reliability gate.
- The secrets and personal-info blocker stays.

**New warnings for coding agents** in `danger.py`. Prompts now go to agents that can run commands, so add a factor with plain titles that keeps reason ids stable, following the `_JAILBREAK_PLAIN` pattern:
- downloading and running scripts (`curl … | sh`)
- deleting everything (`rm -rf`, "delete all files")
- reading or printing `.env`, keys or passwords
- force-pushing or rewriting history
- turning off tests, auth or security checks
- sending code or data to outside URLs or webhooks

Add about 25 cases to `tests/eval/prompt_danger_cases.yaml`.

**Send flow.** `SendDialog` shows these warnings inline before a coding-agent send ("Read this before sending: it asks your agent to download and run something" [Send anyway]).

**Website:**
- The `/prompts` landing drops `PromptScoreBox` and the "safety rating" and "vote" points. The new hero is "250 ready-to-use prompts → send to your agent in one click".
- The `/p/[id]` page shows a warning only when one applies.
- The OG image drops the "DANGER n/100" pill.
- `summaryLine()` drops the danger text.

**Cost** stays: `CostPanel` and the card cost line.

## 3. Simple for non-technical users
- **Read-first detail page.** It opens on: title, what it does, the prompt text, the blanks to fill, a big **Send to…** button, warnings (if any), and Similar prompts. The current edit form moves behind **Edit**, for owners only. Non-owners see a clean read view with "Save a copy" and no disabled inputs.
- **Library card.** Shows title, a one-line description, category and a **Send** button. The button reuses the last agent picked, so a prompt with no blanks takes one click.
- **Sidebar for the prompts workspace:** Library · **Connect your agent** · Prompt workflows.
- **Plain category chips** replace the free-text use_case values in the seed.
- **Copy rules** (from memory): no tokens/QA/fork/model-ID wording; use `modelName()`; say "each time".

## 4. Send to every agent
**New `frontend/src/lib/agentTargets.ts`.** The single registry: `{id, name, group, kind: link|copy-open|mcp, build(text)→url, maxLen, help}`. It uses `fillPrompt` and moves the `{{var}}` regex, which is copied today into `PromptDetail.tsx:28`, `UseModal.tsx:15` and `QaPanel.tsx:47`, into `promptFormat.ts` as one shared export.

Targets marked *verify* get clicked for real on this Mac before shipping. Any that fail become `copy-open` ("Copied. Paste it with ⌘V.").

| Agent | Link |
|---|---|
| Claude Code (terminal) | `claude-cli://open?q=` (max 5,000 characters; help text: "Nothing happened? Open Claude Code once, then try again") |
| Claude Code (desktop) | `claude://code/new?q=` *verify* |
| Cursor | `cursor://anysphere.cursor-deeplink/prompt?text=`, with fallback `https://cursor.com/link/prompt?text=`; test the `&` bug |
| Windsurf | `windsurf://cascade/newChat?prompt=` *verify* |
| Lovable | `https://lovable.dev/#prompt=` |
| Replit | `https://replit.com/?stack=Build&prompt=<lz-string>` (adds `lz-string`) |
| Bolt, v0, GitHub Copilot, OpenAI Codex, Gemini, Kiro, Zed, Trae, JetBrains | copy-open, unless the agent finds a documented link and verifies it |
| ChatGPT | `https://chatgpt.com/?q=` (exists today) |
| Claude.ai | `https://claude.ai/new?q=` (exists today) |
| Perplexity | `perplexity.ai/search?q=` *verify* |
| Grok | `grok.com/?q=` *verify* |
| **My connected agent** | MCP send (§5), shown once connected |

**`SendDialog.tsx`** replaces `UseModal.tsx`:
1. Fill in the blanks, if there are any.
2. Pick an agent from groups: Coding agents / App builders / Chat apps.

The chosen agent is remembered in localStorage (wrapped in try/catch), and `recordUse` fires once per send. If the text is over `maxLen`, the dialog falls back to copy-open.

**`SendButton.tsx` (cards).** It prefetches the prompt on hover or focus. If the fetch hasn't finished at click time, it opens the window synchronously and navigates once the text arrives, so popup blockers and the clipboard user-activation rule don't break it. Custom schemes use `location.href`.

**Website `/p/[id]`.** Gets the same buttons from a small mirrored list in `website/lib/prompts.ts`. That file already mirrors `modelName` this way.

## 5. MCP server, tokens, inbox
**Separate virtualenv.** Create `backend/.venv` for this worktree, which is already gitignored. Today the worktree borrows `~/ActionGate/backend/venv`, which the main checkout (on `feat/github-scan-v2`) also uses. Changing dependencies there would break it.

**MCP SDK.** Use the official `mcp` Python SDK (FastMCP, streamable HTTP, `stateless_http=True`, `json_response=True`), mounted at `/mcp`, with its session manager wired into the app lifespan.
- **Risk:** `pydantic==2.9.2` is pinned, and recent `mcp` needs ≥2.11. Bump it if the **full** backend suite passes on the new venv; otherwise use the newest `mcp` compatible with the current pin.
- **Last resort:** a small hand-rolled JSON-RPC handler.

**Migration 0018.** The main repo is at 0015, so the number is free. Both tables use org RLS like 0016.
- `prompt_agent_tokens`: id, org_id, user_id, label, token_hash, created_at, last_used_at, revoked_at.
- `prompt_sends`: id, org_id, user_id, prompt_id, title, text + text_enc through the `encryption.split` seam (like `qa_runs.output_enc`), created_at, delivered_at, expires_at (24 h).

**Tokens.** Format `ap_<token_urlsafe(32)>`, stored as sha256, per user and limited to prompts. Endpoints `GET/POST/DELETE /api/prompts/agent-tokens`; the plain token is returned once. An ASGI middleware on `/mcp` checks `Authorization: Bearer ap_…`, puts the user in a contextvar, updates `last_used_at`, and returns 401 for missing, bad or revoked tokens.

**Inbox.**
- `POST /api/prompts/{id}/send {values}` → `{id, expires_at}`
- `GET /api/prompts/sends` returns recent sends with their delivered status, which the Connect page's "Test it" uses.

**MCP surface:**
- **Tools:**
  - `get_sent_prompt`: newest undelivered send. Delivered once, then marked.
  - `search_prompts(query, limit)`
  - `get_prompt(id, values)`: returns the filled text
  - `similar_prompts(id)`

  Library content is returned wrapped: "From Arceo Prompts: 'title' by author. The user chose to send this."
- **MCP prompts**, which agents show as slash commands: `sent`, plus one per prompt the user owns or has saved, with the blanks as arguments.
- **Server `instructions`:** "When the user says 'run my Arceo prompt', call get_sent_prompt and follow it."
- **Server name:** `arceo`, so the Claude Code slash command is `/mcp__arceo__sent`.

**Page `/prompts/connect` ("Connect your agent").** One click creates a token, then shows per-agent setup:
- **Cursor:** one-click `cursor://anysphere.cursor-deeplink/mcp/install?name=arceo&config=<base64>`.
- **VS Code:** `vscode:mcp/install?…` *verify*.
- **Claude Code:** a copyable `claude mcp add --transport http arceo <API>/mcp --header "Authorization: Bearer …"`.
- **Windsurf, Codex, Zed:** a config snippet.
- **Anything else:** a generic JSON block.

The page also has token list/revoke and a **Test it** button that sends a sample prompt and watches for delivery. It says plainly that claude.ai and Claude Desktop connectors need OAuth and aren't supported yet.

## 6. More prompts (46 → about 250)
**File layout.**
- Split the seed into `backend/prompts/seed/*.yaml`, one file per category.
- `seed.py` globs the directory.
- The current 46 move to `seed/business.yaml` with plain categories ("Running the business", "Marketing & social", "Sales", "Customer support", "Planning", "Money").

Titles stay as-is, since titles are the idempotency key.

**About 200 new prompts:**
- **Building with a coding agent (about 110):** Build a page or feature, Fix & debug, Look & feel, Forms, data & accounts, Launch & share (deploy, domain, SEO, analytics), Understand & plan.
- **Everyday work (about 90):** Email & messages, Meetings & notes, Writing & editing, Social & marketing, Planning & decisions, Research & summaries, Customer support, Personal.

**Every prompt must:**
- use plain words
- have blanks with realistic samples
- fence any pasted content and include the data rule
- come out low or medium on the warning check
- be unique by title
- not be close or same to any other seed prompt (the §1 algorithm)
- pass a jargon lint (no "token", "QA", "inject", "fork", model IDs, and so on)

`test_prompt_seed.py` checks all of these, with size ≥ 240.

---

## API and module contracts (shared spec for the parallel agents)
`Match = {id, title, description, use_case, author_name, owned, copy_of_yours, level: "same"|"close"|"related", score, shared: str[], yours_only: str[], theirs_only: str[], note?: str}`

**Endpoints:**
- `POST /api/prompts/similar {body, title?, description?, use_case?, variables?, exclude_id?, k=5, mode: "live"|"save"} → {matches: Match[]}`
- `GET /api/prompts/{id}/similar?k=6` and `GET /api/public/prompts/{id}/similar?k=6` (public candidates only)

**New backend files:**
- `prompts/similarity.py`, `similarity_lexicon.yaml`, `similarity_weights.json`, `similarity_fit.py`, `similar_router.py`
- `prompts/agent_tokens.py`, `prompts/sends.py`, `prompts/mcp_server.py`, `prompts/agent_router.py`

The new routers are mounted next to the existing ones at `main.py:8364`.

**New frontend files:**
- `lib/similarApi.ts`, `lib/agentApi.ts`, `lib/agentTargets.ts`
- `components/prompts/{SendDialog,SendButton,SimilarPrompts,DuplicateCheck,Warnings}.tsx`
- `pages/PromptsConnect.tsx`

**Reuse:**
- `fillPrompt`, `modelName`, `blankName` (`lib/promptFormat.ts`)
- `template.VAR_RE` and `render`
- `danger._DATA_RULE`, `_REVIEW_RULE`, `_is_delimited`
- `store.PUBLIC_PRED` and `list_prompts`
- `ai_check`'s caching pattern
- `encryption.split`
- `components/prompts/ui.tsx` primitives
- `lib/shareUrl.ts`

## Execution: ultracode workflow
**Step 0, me, before the workflow:**
- Commit the current uncommitted work on `feat/prompt-library` as a checkpoint, without `tsconfig.tsbuildinfo` and without pushing.
- Copy this plan to `docs/prompts-rework-plan.md` so every agent reads the same spec.

**Parallel-safety rules for every agent:**
- Each agent edits only the files it owns. New routers and API modules exist so agents never share a file.
- Each agent sets its own `ARCEO_TEST_DATABASE_URL=…/arceo_test_<agent>` and `REDIS_URL=redis://localhost:6379/<n>`. Conftest drops the database and flushes Redis db 15 between tests, so shared values would break parallel runs.
- Agents run only their own test files. The full suite runs once, alone, in the Verify phase.
- No commits inside the workflow.

**Phases:**
1. **Foundation** (1 agent):
   - create `.venv` and resolve `mcp` + `snowballstemmer` (+ pydantic bump) against the full suite
   - migration 0018
   - empty routers, mounted
   - seed directory split and loader
   - shared `{{var}}` regex export
   - stub TS API modules matching the contracts
2. **Build** (11 agents in parallel):
   - B1: similarity engine, lexicon, endpoints, search upgrade, unit tests
   - B2: MCP, tokens, inbox, tests
   - B3: coding-agent warnings, danger eval cases, publish-rule change, test updates
   - C1–C5: about 40 new prompts each, by category file, each run through the seed validator
   - F1: agentTargets with vitest, SendDialog, SendButton, Connect page
   - F2: SimilarPrompts, DuplicateCheck, Warnings
   - W1: website
3. **Calibrate + integrate** (in parallel):
   - E1–E2 generate the eval set from the final corpus (half each).
   - Then E3 fits weights and thresholds, iterating on lexicon and payload rules until the holdout targets pass. It reports the metrics table.
   - Meanwhile F3 wires the pages: Library cards and search, the read-first PromptDetail with Edit, the new-prompt match flow, PublicPrompt, CreatorProfile, Workflows, Sidebar, TopBar, routes.
4. **Verify** (1 agent):
   - full backend suite (2 known failures already exist: `test_budget_gate_hardening` and `test_price_time_dimension`)
   - `npx tsc --noEmit`, `npm test`, `npm run build`, website build
   - run the app locally and screenshot every changed screen with Playwright via bun, in light and dark and at phone width
5. **Review** (3 in parallel, adversarial):
   - (a) correctness and security: MCP auth, org isolation for sends, search and similar results, token handling, encryption, the risk of a prompt carrying malicious instructions to a coding agent
   - (b) non-technical UX and copy-rules audit from screenshots
   - (c) attack the similarity algorithm with crafted false positives and negatives, which then become new eval cases
6. **Fix** (1–2 agents): apply confirmed findings and rerun the affected tests and the eval.

**Then me:**
- Click each deep link for real on this Mac (Claude Code, Cursor, Windsurf, Lovable, Replit, chat apps) and turn any that fail into copy-open.
- Connect the MCP server to Claude Code, send a prompt from the library, run `/mcp__arceo__sent`, and confirm it arrives.
- Make local commits grouped by area. No push.
- Write the brain note `Decisions/2026-11-11 Prompts - send to your agent, match before you add.md` and update the `arceo_prompt_library` memory.
- Report back with the similarity metrics table and screenshots.

## Verification (done means all of these pass)
- **Backend:** all new tests pass, plus the existing prompt tests (with updated publish rules): `test_prompt_similarity.py` (canonicalization, payload extraction, levels, visibility and org isolation, no self-match, fork labeling), `test_prompt_similarity_eval.py` (holdout targets), `test_prompt_mcp.py` (401 cases, initialize/tools/prompts, delivered-once, cross-org isolation, filling blanks), the expanded `test_prompt_seed.py` and the danger eval.
- **Frontend:** vitest for URL builders (encoding, `&`, maxLen fallback, lz-string), tsc and build clean.
- **Live:** paste a seed prompt filled with real content into New prompt and see "Already in the library". Send from a card in one click. Deep links arrive typed in. MCP delivery works from Claude Code. No score, ring or leaderboard anywhere in the prompts UI. Light and dark both look right, and phone width works.
