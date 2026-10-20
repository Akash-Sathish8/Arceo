import { describe, expect, it } from "vitest"
import { fillPrompt } from "./promptFormat"

describe("fillPrompt", () => {
  it("fills every occurrence and tolerates spacing", () => {
    expect(fillPrompt("Hi {{name}}, {{ name }}! {{x}}", { name: "Ann", x: "1" })).toBe("Hi Ann, Ann! 1")
  })
  it("leaves missing values blank", () => {
    expect(fillPrompt("A {{a}} B", {})).toBe("A  B")
  })
})
