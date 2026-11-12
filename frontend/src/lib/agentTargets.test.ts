import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import LZString from "lz-string"
import {
  CONNECTED_TARGET, DEFAULT_MAX_URL, GROUP_ORDER, SERVER_NAME, TARGETS,
  actsOnComputer, connectSetups, copySync, findTarget, isAppLink, pasteKeys, planSend,
  rememberTarget, rememberedTargetId, searchTargets, sendTo, wellFormed, type AgentTarget,
} from "./agentTargets"

const t = (id: string): AgentTarget => {
  const found = findTarget(id)
  if (!found) throw new Error(`no target ${id}`)
  return found
}

/** Every character class that has broken prompt links somewhere. */
const NASTY = [
  "plain words with spaces",
  "Q&A: fish & chips & more",
  "a #hash and #fragment",
  "100% sure, %20 is not a space, %26 neither",
  "line one\nline two\r\nline three",
  "emoji 🚀👩‍💻 and accents café",
  `quotes "double" 'single' \`back\``,
  "plus + signs + stay",
  "query?x=1&y=2;z=3/slash\\back",
  "<email>{{email}}</email>",
]

/** Pull a query/fragment parameter out of a built link the way an app would. */
function param(url: string, name: string): string | null {
  const q = url.indexOf("?")
  const h = url.indexOf("#")
  const fromHash = h >= 0 && (q < 0 || h < q) ? url.slice(h + 1) : null
  const query = fromHash ?? url.slice(q + 1)
  return new URLSearchParams(query).get(name)
}

describe("registry", () => {
  it("has unique ids and plain names", () => {
    const ids = TARGETS.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(CONNECTED_TARGET.id)
    for (const x of TARGETS) {
      expect(x.name.trim()).toBe(x.name)
      expect(GROUP_ORDER).toContain(x.group)
      // Copy rules: no jargon in anything a person reads.
      const said = [x.name, x.help ?? "", x.pasteWhere ?? ""].join(" ")
      expect(said).not.toMatch(/\b(tokens?|QA|LLM|API|inject\w*|jailbreak|fork|probe|red team)\b/i)
    }
  })

  it("covers every group with a short popular list", () => {
    for (const g of GROUP_ORDER) {
      const all = TARGETS.filter((x) => x.group === g)
      const popular = all.filter((x) => x.popular)
      expect(all.length).toBeGreaterThan(popular.length)
      expect(popular.length).toBeGreaterThanOrEqual(3)
      expect(popular.length).toBeLessThanOrEqual(4)
    }
  })

  it("documents every link target that isn't flagged for a real click test", () => {
    for (const x of TARGETS.filter((x) => x.kind === "link")) {
      if (!x.verify && !x.verifiedOn) expect(x.docs, x.id).toMatch(/^https:\/\//)
    }
  })

  it("never puts the prompt in a copy-open URL", () => {
    const secret = "SECRET prompt text 123"
    for (const x of TARGETS.filter((x) => x.kind === "copy-open")) {
      const url = x.build(secret)
      expect(url, x.id).not.toContain("SECRET")
      expect(url, x.id).not.toContain(encodeURIComponent(secret))
      expect(planSend(x, secret)).toEqual({ url: url || null, copy: true, reason: "copy-open" })
    }
  })

  it("only opens web pages over https", () => {
    for (const x of TARGETS) {
      for (const url of [x.build("hi"), x.openUrl ?? ""]) {
        if (url && !isAppLink(url)) expect(url, x.id).toMatch(/^https:\/\//)
      }
    }
  })

  it("finds targets by id, including the connected agent", () => {
    expect(findTarget("cursor")?.name).toBe("Cursor")
    expect(findTarget("connected")).toBe(CONNECTED_TARGET)
    expect(findTarget("nope")).toBeUndefined()
    expect(findTarget(null)).toBeUndefined()
  })

  it("search matches names, ids and group words", () => {
    expect(searchTargets("").length).toBe(TARGETS.length)
    expect(searchTargets("claude code").map((x) => x.id)).toEqual(
      expect.arrayContaining(["claude-code", "claude-desktop-code", "claude-code-web", "claude-code-vscode"]))
    expect(searchTargets("LOVABLE").map((x) => x.id)).toEqual(["lovable"])
    expect(searchTargets("chat apps").every((x) => x.group === "chat")).toBe(true)
    expect(searchTargets("zzzz")).toEqual([])
  })

  it("only coding agents and app builders get warnings before a send", () => {
    expect(actsOnComputer(t("cursor"))).toBe(true)
    expect(actsOnComputer(t("lovable"))).toBe(true)
    expect(actsOnComputer(t("chatgpt"))).toBe(false)
    expect(actsOnComputer(CONNECTED_TARGET)).toBe(true)
  })
})

describe("link builders", () => {
  const cases: [string, string, string][] = [
    ["claude-code", "claude-cli://open?q=", "q"],
    ["cursor", "cursor://anysphere.cursor-deeplink/prompt?text=", "text"],
    ["codex", "codex://threads/new?prompt=", "prompt"],
    ["vscode-copilot", "vscode://GitHub.Copilot-Chat/chat?prompt=", "prompt"],
    ["claude-desktop-code", "claude://code/new?q=", "q"],
    ["claude-code-web", "https://claude.ai/code?prompt=", "prompt"],
    ["claude-code-vscode", "vscode://anthropic.claude-code/open?prompt=", "prompt"],
    ["github-copilot", "https://github.com/copilot?prompt=", "prompt"],
    ["lovable", "https://lovable.dev/#prompt=", "prompt"],
    ["chatgpt", "https://chatgpt.com/?q=", "q"],
    ["claude", "https://claude.ai/new?q=", "q"],
    ["perplexity", "https://www.perplexity.ai/search/new?q=", "q"],
    ["grok", "https://grok.com/?q=", "q"],
  ]

  it.each(cases)("%s uses its documented address", (id, prefix) => {
    expect(t(id).kind).toBe("link")
    expect(t(id).build("hello world")).toBe(`${prefix}hello%20world`)
  })

  it.each(cases)("%s round-trips every awkward character", (id, _prefix, name) => {
    for (const text of NASTY) {
      const url = t(id).build(text)
      expect(param(url, name)).toBe(text)
      // Nothing that would split or end the parameter survives unencoded.
      const value = url.slice(_prefix.length)
      // (' ! ( ) * are left as-is by encodeURIComponent and are safe in a query.)
      expect(value).not.toMatch(/[ &#\n\r+"<>`]|%(?![0-9A-F]{2})/)
    }
  })

  it("encodes spaces as %20, never +, and keeps literal + as %2B (Cursor shows + as-is)", () => {
    const url = t("cursor").build("a b+c")
    expect(url).toBe("cursor://anysphere.cursor-deeplink/prompt?text=a%20b%2Bc")
  })

  it("keeps & inside Cursor's text parameter (%26), so nothing after it is cut off", () => {
    const url = t("cursor").build("Test Prompt & Continuation")
    expect(url).toBe("cursor://anysphere.cursor-deeplink/prompt?text=Test%20Prompt%20%26%20Continuation")
    const parsed = new URL(url)
    expect(parsed.searchParams.get("text")).toBe("Test Prompt & Continuation")
    expect([...parsed.searchParams.keys()]).toEqual(["text"])
  })

  it("writes line breaks as %0A, as Claude Code's docs ask", () => {
    expect(t("claude-code").build("one\ntwo")).toBe("claude-cli://open?q=one%0Atwo")
  })

  it("Replit compresses with lz-string and decompresses to the same text", () => {
    for (const text of [...NASTY, "Build a todo app with a clean, modern design"]) {
      const url = t("replit").build(text)
      expect(url.startsWith("https://replit.com/?stack=Build&prompt=")).toBe(true)
      // Placed raw, exactly as Replit's docs do: the alphabet is URL-safe.
      const packed = url.slice("https://replit.com/?stack=Build&prompt=".length)
      expect(packed).toBe(LZString.compressToEncodedURIComponent(text))
      expect(packed).toMatch(/^[A-Za-z0-9+\-$]*$/)
      expect(LZString.decompressFromEncodedURIComponent(packed)).toBe(text)
      // Even a parser that turns "+" into a space gets it back: lz-string swaps
      // spaces back to "+" before decompressing.
      const parsed = new URL(url).searchParams.get("prompt")!
      expect(LZString.decompressFromEncodedURIComponent(parsed)).toBe(text)
      expect(new URL(url).searchParams.get("stack")).toBe("Build")
    }
  })
})

describe("planSend", () => {
  it("opens the link straight away when it fits", () => {
    expect(planSend(t("lovable"), "Make a page")).toEqual({ url: "https://lovable.dev/#prompt=Make%20a%20page", copy: false, reason: "link" })
  })

  it("falls back to copying past the app's own limit, and opens the app without the prompt", () => {
    const long = "x".repeat(5001)
    expect(planSend(t("claude-code"), "x".repeat(5000)).reason).toBe("link")
    expect(planSend(t("claude-code"), long)).toEqual({ url: "claude-cli://open", copy: true, reason: "too-long" })
  })

  it("counts the encoded link length, not just the characters", () => {
    // 3,000 emoji are 6,000 UTF-16 characters but ~36,000 once encoded.
    const emoji = "🚀".repeat(3000)
    const p = planSend(t("cursor"), emoji)
    expect(p.reason).toBe("too-long")
    expect(p.url).toBeNull()            // Cursor has no documented plain address
    expect(p.copy).toBe(true)
  })

  it("uses the default limit for web links that don't set one", () => {
    const x = t("chatgpt")
    expect(x.maxUrlLen).toBeUndefined()
    const fits = "a".repeat(DEFAULT_MAX_URL - x.build("").length)
    expect(planSend(x, fits).reason).toBe("link")
    expect(planSend(x, `${fits}a`)).toEqual({ url: "https://chatgpt.com/", copy: true, reason: "too-long" })
  })

  it("lets Lovable take long prompts in the part after # (never sent to a server)", () => {
    expect(planSend(t("lovable"), "word ".repeat(9000)).reason).toBe("link")
    expect(planSend(t("lovable"), "x".repeat(50001)).reason).toBe("too-long")
  })

  it("also copies for Cursor when the prompt has &, because of its known link bug", () => {
    expect(planSend(t("cursor"), "fish & chips")).toMatchObject({ copy: true, reason: "link-bug" })
    expect(planSend(t("cursor"), "fish and chips")).toMatchObject({ copy: false, reason: "link" })
  })
})

describe("sendTo", () => {
  let opened: string[]
  let href: string
  let clipboard: string | null
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    opened = []
    href = "https://app.example.com/prompts"
    clipboard = null
    writeText = vi.fn(async (s: string) => { clipboard = s })
    vi.stubGlobal("window", {
      open: vi.fn((url: string) => { opened.push(url); return null }),
      location: { get href() { return href }, set href(v: string) { href = v } },
    })
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", platform: "MacIntel" })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it("opens web links in a new tab without a way back to this page", async () => {
    const r = await sendTo(t("chatgpt"), "Hi there")
    expect(window.open).toHaveBeenCalledWith("https://chatgpt.com/?q=Hi%20there", "_blank", "noopener,noreferrer")
    expect(r).toMatchObject({ status: "opened", opened: true, copied: false, reason: "link" })
    expect(clipboard).toBeNull()
  })

  it("hands app links to the computer through location, without a new tab", async () => {
    const r = await sendTo(t("claude-code"), "Fix the bug")
    expect(href).toBe("claude-cli://open?q=Fix%20the%20bug")
    expect(opened).toEqual([])
    expect(r.status).toBe("opened")
    expect(r.message).toMatch(/press Enter/)
  })

  it("copy-open copies, then opens the app's own address, and says how to paste", async () => {
    const r = await sendTo(t("bolt"), "Build me a shop")
    expect(clipboard).toBe("Build me a shop")
    expect(opened).toEqual(["https://bolt.new/"])
    expect(r).toMatchObject({ status: "copied", copied: true, opened: true, reason: "copy-open" })
    expect(r.message).toBe("Copied. Paste it in the prompt box with Cmd+V.")
  })

  it("copy-only targets copy and tell the person where to paste", async () => {
    const r = await sendTo(t("zed"), "Explain this file")
    expect(clipboard).toBe("Explain this file")
    expect(opened).toEqual([])
    expect(href).toBe("https://app.example.com/prompts")
    expect(r.message).toBe("Copied. Open Zed and paste it in Zed's agent panel with Cmd+V.")
  })

  it("says Ctrl+V off a Mac", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" })
    expect(pasteKeys()).toBe("Ctrl+V")
    expect((await sendTo(t("bolt"), "x")).message).toContain("Ctrl+V")
  })

  it("falls back to copy-open with a plain note when the prompt is too long", async () => {
    const long = "y".repeat(5001)
    const r = await sendTo(t("claude-code"), long)
    expect(clipboard).toBe(long)
    expect(href).toBe("claude-cli://open")
    expect(r).toMatchObject({ status: "copied", reason: "too-long", copied: true, opened: true })
    expect(r.message).toMatch(/^It's too long to open Claude Code with the prompt in it, so we copied it\. Paste it/)
  })

  it("opens Cursor and copies as a safety net when the prompt has &", async () => {
    const r = await sendTo(t("cursor"), "Q&A page")
    expect(href).toBe("cursor://anysphere.cursor-deeplink/prompt?text=Q%26A%20page")
    expect(clipboard).toBe("Q&A page")
    expect(r).toMatchObject({ status: "opened", copied: true, reason: "link-bug" })
  })

  it("reports a failed copy so the dialog can show the text to copy by hand", async () => {
    writeText.mockRejectedValueOnce(new Error("Document is not focused"))
    const r = await sendTo(t("gemini"), "Plan my week")
    expect(r.status).toBe("copy-failed")
    expect(r.copied).toBe(false)
    expect(r.message).toMatch(/Couldn't copy it automatically/)
  })

  it("starts the copy before opening (both must happen inside the click)", async () => {
    const order: string[] = []
    writeText.mockImplementation(async () => { order.push("copy") })
    ;(window.open as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push("open"); return null })
    await sendTo(t("bolt"), "x")
    expect(order).toEqual(["copy", "open"])
  })

  it("puts the page in a tab opened earlier, cutting its link back to us", async () => {
    const win = { closed: false, opener: {} as unknown, location: { href: "about:blank" }, close: vi.fn() }
    await sendTo(t("lovable"), "Shop", { win: win as unknown as Window })
    expect(win.location.href).toBe("https://lovable.dev/#prompt=Shop")
    expect(win.opener).toBeNull()
    expect(window.open).not.toHaveBeenCalled()
  })

  it("closes a tab opened earlier when the target is an app link", async () => {
    const win = { closed: false, opener: null, location: { href: "about:blank" }, close: vi.fn() }
    await sendTo(t("claude-code"), "Hi", { win: win as unknown as Window })
    expect(win.close).toHaveBeenCalled()
    expect(href).toBe("claude-cli://open?q=Hi")
  })

  it("does nothing for an empty prompt or the connected agent", async () => {
    expect((await sendTo(t("chatgpt"), "   ")).status).toBe("nothing")
    expect((await sendTo(CONNECTED_TARGET, "Hi")).status).toBe("nothing")
    expect(opened).toEqual([])
  })
})

describe("remembered target", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("remembers and reads back the last choice", () => {
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
    vi.stubGlobal("window", { dispatchEvent: vi.fn() })
    expect(rememberedTargetId()).toBeNull()
    rememberTarget("cursor")
    expect(rememberedTargetId()).toBe("cursor")
    expect(window.dispatchEvent).toHaveBeenCalled()
  })

  it("ignores ids that no longer exist", () => {
    vi.stubGlobal("localStorage", { getItem: () => "retired-agent", setItem: () => {} })
    expect(rememberedTargetId()).toBeNull()
  })

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError") }, setItem: () => { throw new Error("QuotaExceeded") } })
    expect(rememberedTargetId()).toBeNull()
    expect(() => rememberTarget("cursor")).not.toThrow()
  })
})

describe("connectSetups", () => {
  const url = "https://app.example.com/mcp"
  const key = "ap_AbC-123_xyz"
  const setups = connectSetups(url, key)
  const by = (id: string) => setups.find((s) => s.id === id)!

  it("names the server arceo, so Claude Code's shortcut is /mcp__arceo__sent", () => {
    expect(SERVER_NAME).toBe("arceo")
  })

  it("gives Claude Code its documented add command", () => {
    expect(by("claude-code").code).toBe(
      `claude mcp add --transport http --scope user arceo ${url} --header "Authorization: Bearer ${key}"`)
  })

  it("builds Cursor's install link as JSON -> base64 -> URL-encoded, server object only", () => {
    const link = by("cursor").installUrl!
    expect(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=arceo&config=")).toBe(true)
    const config = new URL(link).searchParams.get("config")!
    expect(JSON.parse(atob(config))).toEqual({ url, headers: { Authorization: `Bearer ${key}` } })
    // The raw query keeps base64's + / = escaped.
    expect(link.split("config=")[1]).not.toMatch(/[+/=]/)
  })

  it("builds VS Code's install link as URL-encoded JSON with the name inside", () => {
    const link = by("vscode").installUrl!
    expect(link.startsWith("vscode:mcp/install?")).toBe(true)
    const payload = JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length)))
    expect(payload).toEqual({ name: "arceo", type: "http", url, headers: { Authorization: `Bearer ${key}` } })
  })

  it("gives every other agent a snippet that contains the address and the key", () => {
    for (const s of setups) {
      expect(s.code, s.id).toContain(url)
      expect(s.code, s.id).toContain(`Bearer ${key}`)
      expect(s.docs).toMatch(/^https:\/\//)
      if (s.codeKind === "file" && s.code!.trim().startsWith("{")) expect(() => JSON.parse(s.code!)).not.toThrow()
    }
    expect(by("gemini-cli").code).toBe(`gemini mcp add --transport http --scope user --header "Authorization: Bearer ${key}" arceo ${url}`)
    expect(by("codex").code).toContain("[mcp_servers.arceo]")
    expect(JSON.parse(by("zed").code!).context_servers.arceo.url).toBe(url)
    expect(JSON.parse(by("cline").code!).mcpServers.arceo.type).toBe("streamableHttp")
  })
})

// Regression: half an emoji made encodeURIComponent throw inside the click, so
// Send did nothing at all (no tab, no copy, no message).
describe("broken emoji", () => {
  const broken = "bad \ud83d end \ude00 and a whole one \ud83d\ude00"
  it("wellFormed swaps only the broken halves", () => {
    expect(wellFormed(broken)).toBe("bad \uFFFD end \uFFFD and a whole one \ud83d\ude00")
    expect(wellFormed("plain")).toBe("plain")
  })
  it("every target can plan a send without throwing", () => {
    for (const target of TARGETS) expect(() => planSend(target, broken)).not.toThrow()
    expect(decodeURIComponent(planSend(t("claude-code"), broken).url!.split("q=")[1])).toContain("\ud83d\ude00")
  })
})

describe("settings-file setups", () => {
  // Regression: "Add this to ~/.cursor/mcp.json" didn't say how to add it to a
  // file that already lists other servers; pasting the whole object breaks it.
  it("say how to add to a file that already has other servers", () => {
    for (const s of connectSetups("https://x/mcp", "ap_k").filter((x) => x.codeKind === "file")) {
      expect(s.where, s.id).toMatch(/already/)
    }
  })
})

describe("copySync", () => {
  // A modal <dialog> makes the rest of the page inert: a textarea in <body> then
  // can't hold a selection, so "copy" reports success but copies nothing. The
  // Send dialog is modal, so the hidden textarea has to go inside it.
  function fakeDom(modal: boolean) {
    const parents: string[] = []
    const host = (name: string) => ({ appendChild: vi.fn(() => { parents.push(name) }) })
    const dialog = host("dialog")
    const body = host("body")
    const ta = { value: "", style: { cssText: "" }, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() }
    vi.stubGlobal("document", {
      body,
      activeElement: { focus: vi.fn(), closest: vi.fn(() => (modal ? dialog : null)) },
      createElement: vi.fn(() => ta),
      querySelectorAll: vi.fn(() => (modal ? [dialog] : [])),
      execCommand: vi.fn(() => true),
    })
    return parents
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it("copies from inside an open modal dialog", () => {
    const parents = fakeDom(true)
    expect(copySync("hello")).toBe(true)
    expect(parents).toEqual(["dialog"])
  })

  it("uses the page body when no dialog is open", () => {
    const parents = fakeDom(false)
    expect(copySync("hello")).toBe(true)
    expect(parents).toEqual(["body"])
  })
})
