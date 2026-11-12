import { describe, expect, it, vi } from "vitest"

// api.ts reads localStorage when it loads (no such thing under node).
vi.mock("@/lib/api", () => ({ apiBase: () => "", apiFetch: vi.fn(), isLoggedIn: () => false }))

import { afterLoad, opensEarly, sendLabel } from "./SendButton"
import { CONNECTED_TARGET, findTarget } from "@/lib/agentTargets"

const chatgpt = findTarget("chatgpt")!
const claudeCode = findTarget("claude-code")!
const plain = { body: "Write a haiku about autumn.", danger_summary: null }
const withBlanks = { body: "Write a bio for {{name}}.", danger_summary: null }

describe("SendButton after a slow load", () => {
  // Regression: a tab was opened before knowing whether the prompt had blanks,
  // then closed again when it did (almost every prompt), flashing an empty tab.
  // Nothing opens early now; this is what happens once the prompt arrives.
  it("prompts with blanks open the dialog", () => {
    expect(afterLoad(withBlanks, chatgpt)).toBe("dialog")
    expect(afterLoad(withBlanks, claudeCode)).toBe("dialog")
  })
  it("a web app opens the dialog on its list, so the next click can open a tab", () => {
    expect(afterLoad(plain, chatgpt)).toBe("choose")
  })
  it("app links and the connected agent still go in one click", () => {
    expect(afterLoad(plain, claudeCode)).toBe("send")
    expect(afterLoad(plain, CONNECTED_TARGET)).toBe("connected")
  })
  it("no remembered agent opens the dialog", () => {
    expect(afterLoad(plain, undefined)).toBe("dialog")
  })
})

describe("SendButton when the card knows there are no blanks", () => {
  const lovable = findTarget("lovable")!
  const gemini = findTarget("gemini")!
  const warned = { reasons: [{ id: "w1", severity: "high", dismissed: false }] } as never

  it("a web app opens its tab inside the click, then sends into it", () => {
    expect(opensEarly({ hasBlanks: false }, chatgpt)).toBe(true)
    expect(afterLoad(plain, chatgpt, true)).toBe("send")
  })
  it("never when blanks are possible, unknown, or the agent isn't a web link", () => {
    expect(opensEarly({ hasBlanks: true }, chatgpt)).toBe(false)
    expect(opensEarly({}, chatgpt)).toBe(false)
    expect(opensEarly({ hasBlanks: false }, claudeCode)).toBe(false)     // an app link needs no early tab
    expect(opensEarly({ hasBlanks: false }, gemini)).toBe(false)         // copies first; a new tab would take the focus
    expect(opensEarly({ hasBlanks: false }, CONNECTED_TARGET)).toBe(false)
    expect(opensEarly({ hasBlanks: false }, undefined)).toBe(false)
  })
  it("not when an agent that changes things has warnings to show first", () => {
    expect(opensEarly({ hasBlanks: false, dangerSummary: warned }, lovable)).toBe(false)
    expect(opensEarly({ hasBlanks: false, dangerSummary: null }, lovable)).toBe(true)
  })
  it("a prompt that gained blanks since the list loaded still opens the dialog", () => {
    expect(afterLoad(withBlanks, chatgpt, true)).toBe("dialog")
  })
})

describe("sendLabel", () => {
  it("reads naturally for every kind of target", () => {
    expect(sendLabel(undefined)).toBe("Send to…")
    expect(sendLabel(chatgpt)).toBe("Send to ChatGPT")
    expect(sendLabel(CONNECTED_TARGET)).toBe("Send to my agent")
  })
})
