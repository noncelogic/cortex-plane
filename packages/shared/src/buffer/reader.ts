import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { BufferEvent, BufferScanResult } from "./types.js"

export class BufferReader {
  private readonly basePath: string
  private readonly jobId: string

  constructor(basePath: string, jobId: string) {
    this.basePath = basePath
    this.jobId = jobId
  }

  readAll(): BufferEvent[] {
    const files = this.listSessionFiles()
    const events: BufferEvent[] = []
    for (const file of files) {
      const result = this.scanFile(file)
      events.push(...result.events)
    }
    return events
  }

  readLatestSession(): BufferEvent[] {
    const files = this.listSessionFiles()
    if (files.length === 0) return []
    const latest = files[files.length - 1]!
    return this.scanFile(latest).events
  }

  findLastCheckpoint(): BufferEvent | null {
    const files = this.listSessionFiles()
    for (let i = files.length - 1; i >= 0; i--) {
      const result = this.scanFile(files[i]!)
      for (let j = result.events.length - 1; j >= 0; j--) {
        if (result.events[j]!.type === "CHECKPOINT") {
          return result.events[j]!
        }
      }
    }
    return null
  }

  scanFile(filePath: string): BufferScanResult {
    const content = readFileSync(filePath, "utf-8")
    return scanBuffer(content)
  }

  private listSessionFiles(): string[] {
    const jobDir = join(this.basePath, this.jobId)
    if (!existsSync(jobDir)) return []

    return readdirSync(jobDir)
      .filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
      .sort()
      .map((f) => join(jobDir, f))
  }

  get jobDir(): string {
    return join(this.basePath, this.jobId)
  }
}

export function scanBuffer(content: string): BufferScanResult {
  const lines = content.split("\n")
  const events: BufferEvent[] = []
  let corruptedLines = 0
  let lastLineTruncated = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === "") continue

    try {
      const parsed: unknown = JSON.parse(line)

      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "type" in parsed &&
        "timestamp" in parsed
      ) {
        events.push(parsed as BufferEvent)
      } else {
        corruptedLines++
      }
    } catch {
      const isLastNonEmpty = lines.slice(i + 1).every((l) => l.trim() === "")
      if (isLastNonEmpty) {
        lastLineTruncated = true
      } else {
        corruptedLines++
      }
    }
  }

  return { events, corruptedLines, lastLineTruncated }
}
