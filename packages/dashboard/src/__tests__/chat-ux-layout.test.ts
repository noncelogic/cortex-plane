import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC_DIR = path.resolve(__dirname, "..")

function readSrc(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), "utf-8")
}

describe("chat session UX discoverability", () => {
  it("labels current session in toolbar and list", () => {
    const content = readSrc("components/agents/chat-panel.tsx")
    expect(content).toContain("Reset current")
    expect(content).toContain("Current")
    expect(content).toContain("Session {sessions.length - index}")
  })

  it("shows created and last active metadata for sessions", () => {
    const content = readSrc("components/agents/chat-panel.tsx")
    expect(content).toContain("Created:")
    expect(content).toContain("Last active:")
  })
})

describe("chat layout bounded height", () => {
  it("chat panel uses overflow-hidden with max height constraints", () => {
    const content = readSrc("components/agents/chat-panel.tsx")
    expect(content).toContain("max-h-full")
    expect(content).toContain("overflow-hidden")
    expect(content).toContain("min-h-0 flex-1 flex-col overflow-hidden")
  })

  it("agent detail desktop center column allows bounded chat scrolling", () => {
    const content = readSrc("app/agents/[agentId]/page.tsx")
    expect(content).toContain("flex min-h-0 min-w-0 flex-1 flex-col")
    expect(content).toContain('<div className="min-h-0 flex-1">')
  })
})
