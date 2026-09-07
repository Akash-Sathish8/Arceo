# Connecting your agents to Arceo

**Five ways in. Pick one per agent — you do not need all of them.** Most pilots start with a repo
scan or a code upload, then add the GitHub Action once the first report looks right.

Companion documents: `PILOT_OFFER.md` (what the pilot is), `CONFIDENCE_AND_LIMITS.md` (what the
numbers mean), `../DATA_RETENTION.md` (what we store).

---

## Which path should I use?

| Your situation | Use |
|---|---|
| Agent code is in a **public** GitHub repo | **GitHub** — paste the URL |
| Agent code is in a **private** repo | **GitHub Action** — runs in your CI, your token, code never leaves |
| You want to try it right now with a file or folder | **Upload** |
| You want risk checks **on every pull request** | **GitHub Action** |
| Your agent exposes an **MCP server** | **MCP** |
| Your agent is **already running** and you want real cost numbers | **Route through Arceo** |

**For the pilot's cost forecast specifically:** the first four paths tell us what your agent *can*
do. Only **Route through Arceo** (or the SDK) tells us what it *actually* costs — that is the path
to high confidence. Do a static path first to see the risk report, then wire the runtime path.

---

## 1. Upload — code from your machine

**Where:** Connect agent → **Upload**

Drag in a single file, several files, or **a whole folder**. Everything you drop is bundled into
one agent. Arceo reads the code, extracts every action it can take, and returns a risk score,
worst-case scenarios, and a recommended approval policy in about 30 seconds.

**Accepted:** `.py` `.ts` `.tsx` `.js` `.jsx` `.json` `.yaml` `.yml` `.txt` `.md`

> ⚠️ **Drag the unzipped folder, not a `.zip`.** Zip upload does not exist and is not being built.
> A `.zip` will be rejected as an unsupported file type — drop the folder itself and the browser
> walks it for you.

## 2. GitHub — scan a public repository

**Where:** Connect agent → **GitHub**

Paste a repository URL. Arceo walks the tree, picks the files that contain LLM SDK calls
(`anthropic`, `openai`, `langchain`), and runs extraction on each. Roughly 5–8 seconds per file.

**Limits, stated up front:**
- **Public repositories only** on this path. For private repos, use the GitHub Action below.
- **Capped at 25 agents per scan.** A monorepo with more will return the first 25.
- Files without a recognised LLM SDK call are skipped — if your agent wraps its client in a layer
  we don't recognise, use Upload and point us at the right files.

> ⚠️ **Private repos are not self-service in-app during this pilot.** The per-organisation scan
> credential exists in the backend but has no settings screen yet, so we cannot ask you to paste a
> token into the product. The GitHub Action is the supported private-repo path and it is strictly
> better anyway: it runs inside your own CI with your own token, and your code never reaches us.

## 3. GitHub Action — scan on every pull request

**Where:** Connect agent → GitHub ▸ **GitHub Action**

Catches risky agent changes before they merge. Posts a risk report as a PR comment and can block the
merge.

1. **Generate an API key** — Settings → API & Integration → API Keys. **Copy it once; you will not
   see it again.**
2. **Add it as a repo secret** — GitHub → Settings → Secrets → Actions → New secret, named
   `ARCEO_API_KEY`.
3. **Commit the workflow** to `.github/workflows/arceo.yml`. The exact YAML is shown in the product
   on that tab — copy it from there rather than from this document, so it cannot drift.

**Verdicts:** `fail` if any critical chain is found or blast radius exceeds your threshold; `warn`
within 20 points of it; otherwise `pass`. The scan writes nothing to your Arceo workspace — it is
read-only.

> ⚠️ **Use the API key, not your login token.** They are different things and the scan will reject
> the login token with a 401. The Settings screen shows both, labelled.

## 4. MCP — connect a live MCP server

**Where:** Connect agent → Post deployment ▸ **Connect via MCP**

Point Arceo at your MCP server. It calls `tools/list`, imports every tool the server exposes, and
classifies each action's risk automatically. Best path if your agent's capabilities are defined by
its MCP surface rather than by a code file.

You can also import a static MCP or OpenAI function-calling manifest if you would rather not expose
a live endpoint.

## 5. Route through Arceo — real costs and runtime enforcement

**Where:** Connect agent → Post deployment ▸ **Route through Arceo**

**This is the path that produces high-confidence forecasts**, because it is the only one that sees
real traffic.

Two options:

- **Proxy.** Point your agent's model or tool calls at Arceo instead of the vendor, with an
  `X-Agent-ID` header. We enforce your policies, forward the call, and capture the real token counts.
- **SDK.** `pip install arceo`, wrap your LLM client. Calls are reported to Arceo without moving
  your traffic through us.

Either way you also get **runtime enforcement**: policies that block an action or hold it for
approval before it executes, not after.

> **Reaching high confidence needs sustained volume** — 50+ captured calls in any rolling 7 days
> across 3+ distinct days, roughly 215 a month. If your agent runs below that, it stays at the
> moderate band permanently. `CONFIDENCE_AND_LIMITS.md` explains why, and it is worth reading before
> you decide this path is worth the wiring.

---

## After you connect

1. **Check the extraction.** Open the agent and look at the tool and action list. If something is
   missing or wrong, tell us — a wrong inventory makes every downstream number wrong, and it is the
   fastest thing for us to fix.
2. **Run a sandbox sweep.** Moves the forecast from Low to Moderate — a 6× band down to a 2.9× band.
3. **Enter your negotiated model rates** if you have them, in Settings → Cost overrides. List price
   for a customer with a contract is simply the wrong number.
4. **Look at the risk chains**, not just the score. The chains are the part that tends to surprise
   people: individually safe actions that are dangerous in sequence.

## If something goes wrong

- **"API key rejected (401)"** in the GitHub Action → you used the login token. Mint a real API key
  in Settings → API & Integration → API Keys.
- **A scan returned fewer agents than expected** → the 25-agent cap, or files whose LLM client we
  did not recognise. Send us the repo layout.
- **An agent shows "needs sandbox runs"** → it has no traffic and no simulations. That is honest
  rather than broken: we do not extrapolate over agents we have not measured.
- **Anything else** → the shared channel. Response expectations are in `PILOT_OFFER.md`.
