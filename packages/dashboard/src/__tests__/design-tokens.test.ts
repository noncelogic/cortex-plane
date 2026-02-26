import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * CI guardrail: ban raw hex colors in component class strings.
 *
 * Hardcoded hex values in Tailwind arbitrary-value brackets (e.g. bg-[#1c1c27])
 * bypass the design token system and cause visual drift. New colors must be added
 * to globals.css @theme first, then referenced as token-backed classes.
 */

const COMPONENTS_DIR = path.resolve(__dirname, "../components")
const HEX_IN_CLASSNAME = /(?:bg|text|border|ring|fill|stroke|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/g

function collectTsxFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectTsxFiles(full))
    } else if (full.endsWith(".tsx")) {
      files.push(full)
    }
  }
  return files
}

describe("design token compliance", () => {
  it("components must not contain hardcoded hex values in class strings", () => {
    const violations: string[] = []

    for (const file of collectTsxFiles(COMPONENTS_DIR)) {
      const content = readFileSync(file, "utf-8")
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const matches = lines[i]!.match(HEX_IN_CLASSNAME)
        if (matches) {
          const rel = path.relative(COMPONENTS_DIR, file)
          violations.push(`${rel}:${i + 1} → ${matches.join(", ")}`)
        }
      }
    }

    expect(violations, `Found hardcoded hex colors in components:\n${violations.join("\n")}`).toEqual([])
  })
})
