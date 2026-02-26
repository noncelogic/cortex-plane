/**
 * Trace Capture Integration
 *
 * Links Playwright trace recordings to the job timeline. Manages
 * trace metadata persistence and provides download URLs.
 */

import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { TraceMetadata } from "@cortex/shared/browser"

// ---------------------------------------------------------------------------
// Trace Capture Service
// ---------------------------------------------------------------------------

export class TraceCaptureService {
  /** agentId → list of completed trace metadata records */
  private readonly traces = new Map<string, TraceMetadata[]>()
  private readonly baseDownloadPath: string

  constructor(baseDownloadPath = "/api/agents") {
    this.baseDownloadPath = baseDownloadPath
  }

  /**
   * Register a completed trace recording and generate metadata.
   */
  async registerTrace(
    agentId: string,
    jobId: string,
    filePath: string,
    startedAt: string,
    stoppedAt: string,
  ): Promise<TraceMetadata> {
    const traceId = randomUUID()

    let sizeBytes = 0
    try {
      const stats = await fs.stat(filePath)
      sizeBytes = stats.size
    } catch {
      // File may not exist yet if trace is still being written
    }

    const metadata: TraceMetadata = {
      traceId,
      jobId,
      agentId,
      startedAt,
      stoppedAt,
      sizeBytes,
      downloadUrl: `${this.baseDownloadPath}/${agentId}/browser/trace/${traceId}/download`,
    }

    if (!this.traces.has(agentId)) {
      this.traces.set(agentId, [])
    }
    this.traces.get(agentId)!.push(metadata)

    return metadata
  }

  /**
   * Get all trace metadata for an agent.
   */
  getTraces(agentId: string): TraceMetadata[] {
    return this.traces.get(agentId) ?? []
  }

  /**
   * Get a specific trace by ID.
   */
  getTrace(agentId: string, traceId: string): TraceMetadata | undefined {
    return this.getTraces(agentId).find((t) => t.traceId === traceId)
  }

  /**
   * Read trace file contents for download.
   */
  async readTraceFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath)
  }

  /**
   * List trace files on disk for an agent.
   */
  async listTraceFiles(traceDir: string, agentId: string): Promise<string[]> {
    try {
      const files = await fs.readdir(traceDir)
      return files
        .filter((f) => f.includes(agentId) && (f.endsWith(".json") || f.endsWith(".zip")))
        .map((f) => path.join(traceDir, f))
    } catch {
      return []
    }
  }

  /**
   * Clean up all trace metadata for an agent.
   */
  cleanup(agentId: string): void {
    this.traces.delete(agentId)
  }

  /**
   * Shut down and clear all state.
   */
  shutdown(): void {
    this.traces.clear()
  }
}
