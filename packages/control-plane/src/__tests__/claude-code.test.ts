import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChildProcess } from "node:child_process"
import { EventEmitter, Readable } from "node:stream"

import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"

// ──────────────────────────────────────────────────
// Mock child_process before importing the module
// ──────────────────────────────────────────────────

const mockSpawn = vi.fn<(...args: unknown[]) => ChildProcess>()
const mockExecFile = vi.fn()

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}))

// Import after mocks are set up
const { ClaudeCodeBackend } = await import("../backends/claude-code.js")

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function createMockProcess(options?: {
  exitCode?: number
  stdout?: string[]
  stderr?: string
}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess

  const stdoutReadable = new Readable({ read() {} })
  const stderrReadable = new Readable({ read() {} })

  Object.defineProperty(proc, "stdout", { value: stdoutReadable, writable: false })
  Object.defineProperty(proc, "stderr", { value: stderrReadable, writable: false })
  Object.defineProperty(proc, "stdin", { value: null, writable: false })
  Object.defineProperty(proc, "killed", { value: false, writable: true })
  Object.defineProperty(proc, "exitCode", { value: null, writable: true })
  Object.defineProperty(proc, "pid", { value: 12345, writable: false })

  proc.kill = vi.fn().mockImplementation(() => {
    ;(proc as unknown as Record<string, unknown>).killed = true
    return true
  })

  // Schedule stdout lines and exit
  if (options?.stdout) {
    setImmediate(() => {
      for (const line of options.stdout!) {
        stdoutReadable.push(line + "\n")
      }
      stdoutReadable.push(null)

      if (options.stderr) {
        stderrReadable.push(options.stderr)
      }
      stderrReadable.push(null)
      ;(proc as unknown as Record<string, unknown>).exitCode = options.exitCode ?? 0
      proc.emit("exit", options.exitCode ?? 0, null)
      proc.emit("close", options.exitCode ?? 0, null)
    })
  }

  return proc
}

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-001",
    jobId: "job-001",
    agentId: "agent-001",
    instruction: {
      prompt: "Fix the bug in auth.ts",
      goalType: "code_edit",
    },
    context: {
      workspacePath: "/workspace/project",
      systemPrompt: "You are a helpful assistant",
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 60_000,
      maxTokens: 200_000,
      model: "claude-sonnet-4-5-20250929",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 10,
      networkAccess: true,
      shellAccess: true,
    },
    ...overrides,
  }
}

// ──────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────

describe("ClaudeCodeBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key"

    // Default mock for execFile — returns a version string
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: Record<string, unknown>,
        callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (callback) {
          callback(null, { stdout: "1.0.0\n", stderr: "" })
        }
        return { stdout: "1.0.0\n", stderr: "" }
      },
    )
  })

  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"]
  })

  describe("start()", () => {
    it("initializes successfully with default binary path", async () => {
      const backend = new ClaudeCodeBackend()
      await backend.start({})
      expect(mockExecFile).toHaveBeenCalled()
    })

    it("uses custom binaryPath from config", async () => {
      const backend = new ClaudeCodeBackend()
      await backend.start({ binaryPath: "/custom/claude" })

      const call = mockExecFile.mock.calls[0] as unknown[]
      expect(call[0]).toBe("/custom/claude")
    })

    it("throws if binary returns empty version", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
        ) => {
          if (callback) {
            callback(null, { stdout: "", stderr: "" })
          }
        },
      )

      const backend = new ClaudeCodeBackend()
      await expect(backend.start({})).rejects.toThrow("empty version")
    })
  })

  describe("healthCheck()", () => {
    it("returns healthy when binary and API key are present", async () => {
      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const report = await backend.healthCheck()
      expect(report.status).toBe("healthy")
      expect(report.backendId).toBe("claude-code")
      expect(report.details).toHaveProperty("hasApiKey", true)
    })

    it("returns unhealthy when ANTHROPIC_API_KEY is missing", async () => {
      delete process.env["ANTHROPIC_API_KEY"]

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const report = await backend.healthCheck()
      expect(report.status).toBe("unhealthy")
      expect(report.reason).toContain("ANTHROPIC_API_KEY")
    })

    it("returns unhealthy when binary check fails", async () => {
      // Make execFile fail on health check (second call)
      let callCount = 0
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: Record<string, unknown>,
          callback?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
        ) => {
          callCount++
          if (callCount <= 1 && callback) {
            // First call (start) succeeds
            callback(null, { stdout: "1.0.0\n", stderr: "" })
          } else if (callback) {
            // Health check calls fail
            callback(new Error("Binary not found"), { stdout: "", stderr: "" })
          }
        },
      )

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const report = await backend.healthCheck()
      expect(report.status).toBe("unhealthy")
    })
  })

  describe("getCapabilities()", () => {
    it("returns Claude Code capabilities", () => {
      const backend = new ClaudeCodeBackend()
      const caps = backend.getCapabilities()

      expect(caps.supportsStreaming).toBe(true)
      expect(caps.supportsFileEdit).toBe(true)
      expect(caps.supportsShellExecution).toBe(true)
      expect(caps.reportsTokenUsage).toBe(true)
      expect(caps.supportsCancellation).toBe(true)
      expect(caps.supportedGoalTypes).toContain("code_edit")
      expect(caps.maxContextTokens).toBe(200_000)
    })
  })

  describe("executeTask()", () => {
    it("spawns claude process with correct arguments", async () => {
      const mockProc = createMockProcess({
        exitCode: 0,
        stdout: [
          JSON.stringify({
            type: "result",
            result: "Done",
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
        ],
      })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const task = makeTask()
      const handle = await backend.executeTask(task)

      // Verify spawn was called
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const spawnArgs = mockSpawn.mock.calls[0] as unknown[]
      expect(spawnArgs[0]).toBe("claude")

      const cliArgs = spawnArgs[1] as string[]
      expect(cliArgs).toContain("--print")
      expect(cliArgs).toContain("--output-format")
      expect(cliArgs).toContain("stream-json")
      expect(cliArgs).toContain("--model")
      expect(cliArgs).toContain("claude-sonnet-4-5-20250929")
      expect(cliArgs).toContain("--max-turns")
      expect(cliArgs).toContain("10")

      // Consume events to drive completion
      const events: OutputEvent[] = []
      for await (const event of handle.events()) {
        events.push(event)
      }

      const result = await handle.result()
      expect(result.taskId).toBe("task-001")
      expect(result.status).toBe("completed")
    })

    it("parses streaming JSON output events", async () => {
      const mockProc = createMockProcess({
        exitCode: 0,
        stdout: [
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Fixing the bug..." }] },
          }),
          JSON.stringify({
            type: "result",
            result: "Bug fixed",
            usage: { input_tokens: 500, output_tokens: 200 },
          }),
        ],
      })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const handle = await backend.executeTask(makeTask())

      const events: OutputEvent[] = []
      for await (const event of handle.events()) {
        events.push(event)
      }

      // Should have: text event, usage event, complete event
      const textEvents = events.filter((e) => e.type === "text")
      expect(textEvents.length).toBeGreaterThanOrEqual(1)
      expect(textEvents[0]!.type === "text" && textEvents[0]!.content).toBe("Fixing the bug...")

      const usageEvents = events.filter((e) => e.type === "usage")
      expect(usageEvents.length).toBeGreaterThanOrEqual(1)

      const completeEvents = events.filter((e) => e.type === "complete")
      expect(completeEvents).toHaveLength(1)
    })

    it("handles non-JSON stdout lines as text events", async () => {
      const mockProc = createMockProcess({
        exitCode: 0,
        stdout: ["not valid json", JSON.stringify({ type: "result", result: "Done" })],
      })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const handle = await backend.executeTask(makeTask())

      const events: OutputEvent[] = []
      for await (const event of handle.events()) {
        events.push(event)
      }

      const textEvents = events.filter((e) => e.type === "text")
      expect(textEvents.length).toBeGreaterThanOrEqual(1)
      expect(textEvents[0]!.type === "text" && textEvents[0]!.content).toBe("not valid json")
    })

    it("builds a failed result when process exits with non-zero code", async () => {
      const mockProc = createMockProcess({
        exitCode: 1,
        stdout: [],
        stderr: "Error: something went wrong",
      })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const handle = await backend.executeTask(makeTask())

      const events: OutputEvent[] = []
      for await (const event of handle.events()) {
        events.push(event)
      }

      const result = await handle.result()
      expect(result.status).toBe("failed")
      expect(result.exitCode).toBe(1)
      expect(result.error).toBeDefined()
      expect(result.error!.classification).toBe("permanent")
    })

    it("classifies OOM kill (exit code 137) as resource error", async () => {
      const mockProc = createMockProcess({
        exitCode: 137,
        stdout: [],
        stderr: "Killed",
      })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const handle = await backend.executeTask(makeTask())

      for await (const _event of handle.events()) {
        /* consume */
      }

      const result = await handle.result()
      expect(result.status).toBe("failed")
      expect(result.error?.classification).toBe("resource")
    })

    it("includes allowed and denied tools in spawn args", async () => {
      const mockProc = createMockProcess({ exitCode: 0, stdout: [] })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const task = makeTask({
        constraints: {
          ...makeTask().constraints,
          allowedTools: ["Read", "Write"],
          deniedTools: ["Bash"],
        },
      })

      await backend.executeTask(task)

      const cliArgs = (mockSpawn.mock.calls[0] as unknown[])[1] as string[]
      expect(cliArgs).toContain("--allowedTools")
      expect(cliArgs).toContain("Read")
      expect(cliArgs).toContain("Write")
      expect(cliArgs).toContain("--deniedTools")
      expect(cliArgs).toContain("Bash")
    })

    it("builds prompt from system prompt, memories, and instruction", async () => {
      const mockProc = createMockProcess({ exitCode: 0, stdout: [] })
      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const task = makeTask({
        instruction: {
          prompt: "Fix auth",
          goalType: "code_edit",
          targetFiles: ["src/auth.ts"],
        },
        context: {
          workspacePath: "/workspace",
          systemPrompt: "You are Hessian",
          memories: ["User prefers TypeScript"],
          relevantFiles: {},
          environment: {},
        },
      })

      await backend.executeTask(task)

      // The last argument to spawn should be the assembled prompt
      const spawnArgs = mockSpawn.mock.calls[0] as unknown[]
      const cliArgs = spawnArgs[1] as string[]
      const prompt = cliArgs[cliArgs.length - 1]!

      expect(prompt).toContain("You are Hessian")
      expect(prompt).toContain("<memory>")
      expect(prompt).toContain("User prefers TypeScript")
      expect(prompt).toContain("Focus on these files: src/auth.ts")
      expect(prompt).toContain("Fix auth")
    })

    it("enforces process env allowlist and blocks sensitive control-plane vars", async () => {
      const mockProc = createMockProcess({ exitCode: 0, stdout: [] })
      mockSpawn.mockReturnValue(mockProc)

      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})

      const originalEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
        LANG: process.env.LANG,
        TERM: process.env.TERM,
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
      }

      process.env.PATH = "/usr/bin:/bin"
      process.env.HOME = "/home/control-plane"
      process.env.NODE_PATH = "/opt/node_modules"
      process.env.LANG = "en_US.UTF-8"
      process.env.TERM = "xterm-256color"
      process.env.DATABASE_URL = "postgres://secret"
      process.env.REDIS_URL = "redis://secret"
      process.env.INTERNAL_API_KEY = "internal-secret"

      try {
        const backend = new ClaudeCodeBackend()
        await backend.start({})

        const task = makeTask({
          context: {
            ...makeTask().context,
            environment: {
              ANTHROPIC_API_KEY: "sk-task-level",
              TASK_ONLY_FLAG: "enabled",
            },
          },
        })

        await backend.executeTask(task)

        const spawnOptions = (mockSpawn.mock.calls[0] as unknown[])[2] as { env: NodeJS.ProcessEnv }
        const env = spawnOptions.env

        expect(env.PATH).toBe("/usr/bin:/bin")
        expect(env.HOME).toBe("/home/control-plane")
        expect(env.NODE_PATH).toBe("/opt/node_modules")
        expect(env.LANG).toBe("en_US.UTF-8")
        expect(env.TERM).toBe("xterm-256color")

        expect(env.ANTHROPIC_API_KEY).toBe("sk-task-level")
        expect(env.TASK_ONLY_FLAG).toBe("enabled")

        expect(env.DATABASE_URL).toBeUndefined()
        expect(env.REDIS_URL).toBeUndefined()
        expect(env.INTERNAL_API_KEY).toBeUndefined()

        expect(debugSpy).toHaveBeenCalledWith(
          "[backend-env] injected env keys for backend process",
          expect.objectContaining({
            keys: expect.arrayContaining(["ANTHROPIC_API_KEY", "PATH", "TASK_ONLY_FLAG"]),
          }),
        )
      } finally {
        debugSpy.mockRestore()
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }
    })
  })

  describe("cancel()", () => {
    it("sends SIGTERM and resolves result as cancelled", async () => {
      const mockProc = createMockProcess({ exitCode: 0, stdout: [] })
      // Don't auto-emit exit — we want to cancel manually
      mockProc.removeAllListeners("exit")
      ;(mockProc as unknown as Record<string, unknown>).exitCode = null

      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})

      const handle = await backend.executeTask(makeTask())

      // Simulate the process exiting after SIGTERM
      const origKill = mockProc.kill as ReturnType<typeof vi.fn>
      origKill.mockImplementation(() => {
        ;(mockProc as unknown as Record<string, unknown>).killed = true
        ;(mockProc as unknown as Record<string, unknown>).exitCode = 143
        mockProc.emit("exit", 143, "SIGTERM")
        return true
      })

      // Close stdout so the events() generator can finish
      ;(mockProc.stdout as Readable).push(null)

      await handle.cancel("User requested cancellation")

      const result = await handle.result()
      expect(result.status).toBe("cancelled")
      expect(result.summary).toContain("User requested cancellation")
    })
  })

  describe("stop()", () => {
    it("kills active process on stop", async () => {
      const mockProc = createMockProcess({ exitCode: 0, stdout: [] })
      mockProc.removeAllListeners("exit")
      ;(mockProc as unknown as Record<string, unknown>).killed = false

      mockSpawn.mockReturnValue(mockProc)

      const backend = new ClaudeCodeBackend()
      await backend.start({})
      await backend.executeTask(makeTask())

      // Mock kill to emit exit
      const origKill = mockProc.kill as ReturnType<typeof vi.fn>
      origKill.mockImplementation(() => {
        ;(mockProc as unknown as Record<string, unknown>).killed = true
        mockProc.emit("exit", 0, null)
        return true
      })

      await backend.stop()
      expect(origKill).toHaveBeenCalledWith("SIGTERM")
    })

    it("is a no-op when no process is active", async () => {
      const backend = new ClaudeCodeBackend()
      await backend.start({})
      // Should not throw
      await backend.stop()
    })
  })
})
