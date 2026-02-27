import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { BufferEvent, SessionMetadata } from "./types.js"

const FSYNC_INTERVAL_MS = 30_000

export class BufferWriter {
  private readonly basePath: string
  private readonly jobId: string
  private sessionNumber: number
  private sequence: number
  private sessionId: string
  private agentId: string
  private filePath: string
  private fd: number | null
  private lastFsyncAt: number
  private readonly fsyncIntervalMs: number

  constructor(
    basePath: string,
    jobId: string,
    options: {
      agentId?: string
      sessionId?: string
      fsyncIntervalMs?: number
    } = {},
  ) {
    this.basePath = basePath
    this.jobId = jobId
    this.sessionNumber = 0
    this.sequence = 0
    this.sessionId = options.sessionId ?? ""
    this.agentId = options.agentId ?? ""
    this.filePath = ""
    this.fd = null
    this.lastFsyncAt = Date.now()
    this.fsyncIntervalMs = options.fsyncIntervalMs ?? FSYNC_INTERVAL_MS

    const jobDir = join(this.basePath, this.jobId)
    if (!existsSync(jobDir)) {
      mkdirSync(jobDir, { recursive: true })
    }

    this.initSession()
  }

  private initSession(): void {
    this.sessionNumber++
    this.sequence = 0
    const padded = String(this.sessionNumber).padStart(3, "0")
    this.filePath = join(this.basePath, this.jobId, `session-${padded}.jsonl`)
    this.fd = openSync(this.filePath, "a")
    this.lastFsyncAt = Date.now()
  }

  append(event: Omit<BufferEvent, "sequence">): void {
    const fullEvent: BufferEvent = {
      ...event,
      sequence: this.sequence++,
    }

    const line = JSON.stringify(fullEvent) + "\n"
    appendFileSync(this.filePath, line, "utf-8")

    if (event.type === "CHECKPOINT") {
      this.fsync()
    } else if (Date.now() - this.lastFsyncAt >= this.fsyncIntervalMs) {
      this.fsync()
    }
  }

  newSession(): void {
    this.close()
    this.initSession()
  }

  fsync(): void {
    if (this.fd !== null) {
      fdatasyncSync(this.fd)
      this.lastFsyncAt = Date.now()
    }
  }

  close(): void {
    if (this.fd !== null) {
      fdatasyncSync(this.fd)
      closeSync(this.fd)
      this.fd = null
    }
  }

  writeMetadata(metadata: Omit<SessionMetadata, "basePath">): void {
    const metaPath = join(this.basePath, this.jobId, "metadata.json")
    const full: SessionMetadata = { ...metadata, basePath: this.basePath }
    writeFileSync(metaPath, JSON.stringify(full, null, 2) + "\n", "utf-8")
  }

  get currentFilePath(): string {
    return this.filePath
  }

  get currentSessionNumber(): number {
    return this.sessionNumber
  }

  get currentSequence(): number {
    return this.sequence
  }
}
