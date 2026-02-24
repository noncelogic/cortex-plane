/**
 * Claude Code CLI Backend Adapter
 *
 * Spawns `claude --print --output-format stream-json` as a child process,
 * parses the streaming JSON output, and normalizes results into the
 * ExecutionBackend interface.
 *
 * See: docs/spikes/037-execution-backends.md — "Artifact: Claude Code Adapter Spec"
 */

import { type ChildProcess, execFile as execFileCb, spawn } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

import type {
  BackendCapabilities,
  BackendHealthReport,
  ExecutionBackend,
  ExecutionHandle,
  ExecutionResult,
  ExecutionTask,
  FileChange,
  OutputCompleteEvent,
  OutputEvent,
  OutputTextEvent,
  OutputUsageEvent,
  TokenUsage,
} from "@cortex/shared"

const execFile = promisify(execFileCb)

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

export class ClaudeCodeBackend implements ExecutionBackend {
  readonly backendId = "claude-code"

  private binaryPath = "claude"
  private activeProcess: ChildProcess | null = null

  async start(config: Record<string, unknown>): Promise<void> {
    if (typeof config.binaryPath === "string") {
      this.binaryPath = config.binaryPath
    }

    // Verify the binary exists and is executable.
    const { stdout } = await execFile(this.binaryPath, ["--version"], {
      timeout: 10_000,
    })

    if (!stdout.trim()) {
      throw new Error(`Claude binary at '${this.binaryPath}' returned empty version`)
    }
  }

  async stop(): Promise<void> {
    if (!this.activeProcess || this.activeProcess.killed) return

    this.activeProcess.kill("SIGTERM")

    await Promise.race([
      new Promise<void>((resolve) => {
        this.activeProcess!.on("exit", () => resolve())
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])

    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill("SIGKILL")
    }

    this.activeProcess = null
  }

  async healthCheck(): Promise<BackendHealthReport> {
    const start = Date.now()

    try {
      await access(this.binaryPath, constants.X_OK).catch(async () => {
        // binaryPath may not be absolute — fall back to `which`
        await execFile("which", [this.binaryPath], { timeout: 5_000 })
      })

      const { stdout } = await execFile(this.binaryPath, ["--version"], {
        timeout: 5_000,
      })

      const hasApiKey = !!process.env["ANTHROPIC_API_KEY"]
      const latencyMs = Date.now() - start

      if (!hasApiKey) {
        return {
          backendId: this.backendId,
          status: "unhealthy",
          reason: "ANTHROPIC_API_KEY not configured",
          checkedAt: new Date().toISOString(),
          latencyMs,
          details: { version: stdout.trim(), hasApiKey: false },
        }
      }

      return {
        backendId: this.backendId,
        status: latencyMs > 3000 ? "degraded" : "healthy",
        reason: latencyMs > 3000 ? `Health check slow: ${latencyMs}ms` : undefined,
        checkedAt: new Date().toISOString(),
        latencyMs,
        details: { version: stdout.trim(), hasApiKey: true },
      }
    } catch (err) {
      return {
        backendId: this.backendId,
        status: "unhealthy",
        reason: err instanceof Error ? err.message : "Unknown error",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        details: {},
      }
    }
  }

  executeTask(task: ExecutionTask): Promise<ExecutionHandle> {
    const args = this.buildArgs(task)
    const prompt = this.buildPrompt(task)

    const subprocess = spawn(this.binaryPath, [...args, prompt], {
      cwd: task.context.workspacePath,
      env: {
        ...process.env,
        ...task.context.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.activeProcess = subprocess

    // Enforce timeout
    const timeoutTimer = setTimeout(() => {
      if (!subprocess.killed) {
        subprocess.kill("SIGTERM")
        setTimeout(() => {
          if (!subprocess.killed) subprocess.kill("SIGKILL")
        }, 5_000)
      }
    }, task.constraints.timeoutMs)

    subprocess.on("exit", () => {
      clearTimeout(timeoutTimer)
    })

    return Promise.resolve(new ClaudeCodeHandle(task.id, subprocess, task.context.workspacePath))
  }

  getCapabilities(): BackendCapabilities {
    return {
      supportsStreaming: true,
      supportsFileEdit: true,
      supportsShellExecution: true,
      reportsTokenUsage: true,
      supportsCancellation: true,
      supportedGoalTypes: [
        "code_edit",
        "code_generate",
        "code_review",
        "shell_command",
        "research",
      ],
      maxContextTokens: 200_000,
    }
  }

  private buildArgs(task: ExecutionTask): string[] {
    const args: string[] = [
      "--print",
      "--output-format",
      "stream-json",
      "--model",
      task.constraints.model,
      "--max-turns",
      String(task.constraints.maxTurns),
    ]

    for (const tool of task.constraints.allowedTools) {
      args.push("--allowedTools", tool)
    }

    for (const tool of task.constraints.deniedTools) {
      args.push("--deniedTools", tool)
    }

    return args
  }

  private buildPrompt(task: ExecutionTask): string {
    const parts: string[] = []

    if (task.context.systemPrompt) {
      parts.push(task.context.systemPrompt)
    }

    for (const memory of task.context.memories) {
      parts.push(`<memory>\n${memory}\n</memory>`)
    }

    if (task.instruction.conversationHistory?.length) {
      parts.push("Previous conversation:")
      for (const turn of task.instruction.conversationHistory) {
        parts.push(`${turn.role}: ${turn.content}`)
      }
    }

    if (task.instruction.targetFiles?.length) {
      parts.push(`Focus on these files: ${task.instruction.targetFiles.join(", ")}`)
    }

    parts.push(task.instruction.prompt)

    return parts.join("\n\n")
  }
}

// ──────────────────────────────────────────────────
// Execution Handle
// ──────────────────────────────────────────────────

class ClaudeCodeHandle implements ExecutionHandle {
  readonly taskId: string

  private subprocess: ChildProcess
  private workspacePath: string
  private resultPromise: Promise<ExecutionResult>
  private resolveResult!: (result: ExecutionResult) => void
  private resultResolved = false
  private collectedEvents: OutputEvent[] = []
  private stdout = ""
  private stderr = ""
  private startTime: number

  constructor(taskId: string, subprocess: ChildProcess, workspacePath: string) {
    this.taskId = taskId
    this.subprocess = subprocess
    this.workspacePath = workspacePath
    this.startTime = Date.now()

    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })

    // Capture stderr
    subprocess.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString()
    })
  }

  async *events(): AsyncIterable<OutputEvent> {
    const rl = createInterface({ input: this.subprocess.stdout! })

    for await (const line of rl) {
      if (!line.trim()) continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        // Non-JSON line — emit as raw text
        this.stdout += line + "\n"
        const event: OutputTextEvent = {
          type: "text",
          timestamp: new Date().toISOString(),
          content: line,
        }
        this.collectedEvents.push(event)
        yield event
        continue
      }

      const events = this.mapClaudeEvent(parsed)
      for (const event of events) {
        this.collectedEvents.push(event)
        yield event

        if (event.type === "complete") {
          this.settleResult(event.result)
        }
      }
    }

    // Process exited — if we haven't resolved a result, build one from exit code
    if (!this.resultResolved) {
      const exitCode = await this.waitForExit()
      const result = await this.buildFinalResult(exitCode)
      const event: OutputCompleteEvent = {
        type: "complete",
        timestamp: new Date().toISOString(),
        result,
      }
      this.collectedEvents.push(event)
      this.settleResult(result)
      yield event
    }
  }

  async result(): Promise<ExecutionResult> {
    return this.resultPromise
  }

  async cancel(reason: string): Promise<void> {
    if (!this.subprocess.killed) {
      this.subprocess.kill("SIGTERM")

      await Promise.race([
        new Promise<void>((r) => this.subprocess.on("exit", () => r())),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ])

      if (!this.subprocess.killed) {
        this.subprocess.kill("SIGKILL")
      }
    }

    this.settleResult({
      taskId: this.taskId,
      status: "cancelled",
      exitCode: this.subprocess.exitCode,
      summary: `Cancelled: ${reason}`,
      fileChanges: [],
      stdout: this.stdout,
      stderr: this.stderr,
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      artifacts: [],
      durationMs: Date.now() - this.startTime,
    })
  }

  private settleResult(result: ExecutionResult): void {
    if (!this.resultResolved) {
      this.resultResolved = true
      this.resolveResult(result)
    }
  }

  private waitForExit(): Promise<number | null> {
    if (this.subprocess.exitCode !== null) {
      return Promise.resolve(this.subprocess.exitCode)
    }
    return new Promise<number | null>((resolve) => {
      this.subprocess.on("exit", (code) => resolve(code))
    })
  }

  private mapClaudeEvent(event: Record<string, unknown>): OutputEvent[] {
    const events: OutputEvent[] = []
    const type = event.type as string | undefined

    if (type === "assistant" && event.message) {
      const message = event.message as { content: Array<{ type: string; text?: string }> }
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
      if (text) {
        this.stdout += text
        events.push({ type: "text", timestamp: new Date().toISOString(), content: text })
      }
    }

    if (type === "tool_use") {
      const tool = event.tool as { name: string; input: Record<string, unknown> } | undefined
      if (tool) {
        events.push({
          type: "tool_use",
          timestamp: new Date().toISOString(),
          toolName: tool.name,
          toolInput: tool.input,
        })
      }
    }

    if (type === "tool_result") {
      const tool = event.tool as { name: string; output?: string; is_error?: boolean } | undefined
      if (tool) {
        events.push({
          type: "tool_result",
          timestamp: new Date().toISOString(),
          toolName: tool.name,
          output: tool.output ?? "",
          isError: tool.is_error ?? false,
        })
      }
    }

    if (type === "result") {
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined
      const tokenUsage: TokenUsage = {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        costUsd: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }

      events.push({
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage,
      } satisfies OutputUsageEvent)

      // Build the complete event
      const resultText = typeof event.result === "string" ? event.result : this.stdout.slice(-500)
      events.push({
        type: "complete",
        timestamp: new Date().toISOString(),
        result: {
          taskId: this.taskId,
          status: "completed",
          exitCode: 0,
          summary: resultText,
          fileChanges: [],
          stdout: this.stdout,
          stderr: this.stderr,
          tokenUsage,
          artifacts: [],
          durationMs: Date.now() - this.startTime,
        },
      } satisfies OutputCompleteEvent)
    }

    return events
  }

  private async buildFinalResult(exitCode: number | null): Promise<ExecutionResult> {
    const fileChanges = await this.computeFileChanges()
    const usageEvent = this.collectedEvents.find((e) => e.type === "usage")

    const timedOut = exitCode === null || exitCode === 143 // SIGTERM = 128 + 15

    return {
      taskId: this.taskId,
      status: timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed",
      exitCode,
      summary: this.stdout.slice(-500),
      fileChanges,
      stdout: this.stdout,
      stderr: this.stderr,
      tokenUsage: usageEvent?.tokenUsage ?? { ...ZERO_TOKEN_USAGE },
      artifacts: [],
      durationMs: Date.now() - this.startTime,
      error:
        exitCode !== 0 && exitCode !== null
          ? {
              message: this.stderr || `Process exited with code ${exitCode}`,
              classification: exitCode === 137 ? "resource" : "permanent",
              partialExecution: true,
            }
          : timedOut
            ? {
                message: "Process timed out",
                classification: "timeout",
                partialExecution: true,
              }
            : undefined,
    }
  }

  private async computeFileChanges(): Promise<FileChange[]> {
    try {
      const { stdout } = await execFile("git", ["diff", "--name-status", "HEAD"], {
        cwd: this.workspacePath,
        timeout: 5_000,
      })

      return stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [status, ...pathParts] = line.split("\t")
          const path = pathParts.join("\t")
          const operation: FileChange["operation"] =
            status === "A" ? "created" : status === "D" ? "deleted" : "modified"
          return { path, operation, diff: null }
        })
    } catch {
      return []
    }
  }
}
