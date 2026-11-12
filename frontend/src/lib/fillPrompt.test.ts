import { describe, expect, it } from "vitest"
import { fillPrompt } from "./promptFormat"

describe("fillPrompt", () => {
  it("fills every occurrence and tolerates spacing", () => {
    expect(fillPrompt("Hi {{name}}, {{ name }}! {{x}}", { name: "Ann", x: "1" })).toBe("Hi Ann, Ann! 1")
  })
  it("leaves missing values blank", () => {
    expect(fillPrompt("A {{a}} B", {})).toBe("A  B")
  })
  // Regression: empty blanks went to apps as holes ("I need to talk with  about .").
  it("can mark empty blanks so the reader sees what's missing", () => {
    const mark = (n: string) => `[${n.replace(/_/g, " ")}]`
    expect(fillPrompt("Talk with {{person}} about {{topic_name}}.", { person: "Sam", topic_name: "  " }, mark))
      .toBe("Talk with Sam about [topic name].")
    expect(fillPrompt("{{a}}", {}, mark)).toBe("[a]")
  })
})
