import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { scanBuffer } from "./reader.js"
import type { RecoveryState } from "./types.js"

export function recoverFromBuffer(basePath: string, jobId: string): RecoveryState {
  const jobDir = join(basePath, jobId)

  if (!existsSync(jobDir)) {
    return { lastCheckpoint: null, eventsSinceCheckpoint: [], sessionFile: "" }
  }

  const sessionFiles = readdirSync(jobDir)
    .filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
    .sort()

  if (sessionFiles.length === 0) {
    return { lastCheckpoint: null, eventsSinceCheckpoint: [], sessionFile: "" }
  }

  const latestFile = sessionFiles[sessionFiles.length - 1]!
  const filePath = join(jobDir, latestFile)
  const content = readFileSync(filePath, "utf-8")
  const { events } = scanBuffer(content)

  let lastCheckpointIndex = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "CHECKPOINT") {
      lastCheckpointIndex = i
      break
    }
  }

  if (lastCheckpointIndex === -1) {
    return {
      lastCheckpoint: null,
      eventsSinceCheckpoint: events,
      sessionFile: filePath,
    }
  }

  return {
    lastCheckpoint: events[lastCheckpointIndex]!,
    eventsSinceCheckpoint: events.slice(lastCheckpointIndex + 1),
    sessionFile: filePath,
  }
}
