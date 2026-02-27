import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentDeployer } from "../k8s/agent-deployer.js"
import { AgentLifecycleManager, type SteerMessage } from "../lifecycle/manager.js"
import { AgentLifecycleStateMachine } from "../lifecycle/state-machine.js"

function createTestManager() {
  const mockDb = {
    selectFrom: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue(null),
        }),
      }),
    }),
  } as unknown as Kysely<Database>

  const mockDeployer = {
    deployAgent: vi.fn(),
    deleteAgent: vi.fn(),
    getAgentStatus: vi.fn(),
  } as unknown as AgentDeployer

  return new AgentLifecycleManager({
    db: mockDb,
    deployer: mockDeployer,
  })
}

function setAgentState(
  manager: AgentLifecycleManager,
  agentId: string,
  targetState: "READY" | "EXECUTING",
): void {
  const sm = new AgentLifecycleStateMachine(agentId)
  sm.transition("HYDRATING")
  sm.transition("READY")
  if (targetState === "EXECUTING") {
    sm.transition("EXECUTING")
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const agents = (manager as any).agents as Map<string, any>
  agents.set(agentId, {
    agentId,
    jobId: "job-1",
    stateMachine: sm,
    hydration: null,
    deploymentConfig: null,
  })
}

describe("AgentLifecycleManager steering", () => {
  it("steer calls registered listeners", () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "EXECUTING")

    const listener = vi.fn()
    manager.onSteer("agent-1", listener)

    const msg: SteerMessage = {
      id: "steer-1",
      agentId: "agent-1",
      message: "focus on tests",
      priority: "normal",
      timestamp: new Date(),
    }

    manager.steer(msg)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(msg)
  })

  it("steer throws if agent is not managed", () => {
    const manager = createTestManager()

    expect(() => {
      manager.steer({
        id: "steer-1",
        agentId: "agent-unknown",
        message: "test",
        priority: "normal",
        timestamp: new Date(),
      })
    }).toThrow("not managed")
  })

  it("steer throws if agent is in READY state (not EXECUTING)", () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "READY")

    expect(() => {
      manager.steer({
        id: "steer-1",
        agentId: "agent-1",
        message: "test",
        priority: "normal",
        timestamp: new Date(),
      })
    }).toThrow("not in EXECUTING state")
  })

  it("supports multiple listeners per agent", () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "EXECUTING")

    const listener1 = vi.fn()
    const listener2 = vi.fn()
    manager.onSteer("agent-1", listener1)
    manager.onSteer("agent-1", listener2)

    const msg: SteerMessage = {
      id: "steer-1",
      agentId: "agent-1",
      message: "test",
      priority: "normal",
      timestamp: new Date(),
    }

    manager.steer(msg)

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).toHaveBeenCalledTimes(1)
  })

  it("onSteer returns unsubscribe function", () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "EXECUTING")

    const listener = vi.fn()
    const unsub = manager.onSteer("agent-1", listener)

    unsub()

    manager.steer({
      id: "steer-1",
      agentId: "agent-1",
      message: "test",
      priority: "normal",
      timestamp: new Date(),
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it("does not call listeners for other agents", () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "EXECUTING")
    setAgentState(manager, "agent-2", "EXECUTING")

    const listener1 = vi.fn()
    const listener2 = vi.fn()
    manager.onSteer("agent-1", listener1)
    manager.onSteer("agent-2", listener2)

    manager.steer({
      id: "steer-1",
      agentId: "agent-1",
      message: "test",
      priority: "normal",
      timestamp: new Date(),
    })

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).not.toHaveBeenCalled()
  })

  it("steer with high priority passes through", () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "EXECUTING")

    const listener = vi.fn()
    manager.onSteer("agent-1", listener)

    manager.steer({
      id: "steer-1",
      agentId: "agent-1",
      message: "urgent change",
      priority: "high",
      timestamp: new Date(),
    })

    expect((listener.mock.calls[0]![0] as { priority: string }).priority).toBe("high")
  })

  it("cleanup removes steer listeners", async () => {
    const manager = createTestManager()
    setAgentState(manager, "agent-1", "EXECUTING")

    const listener = vi.fn()
    manager.onSteer("agent-1", listener)

    // Terminate triggers cleanup
    await manager.terminate("agent-1", "test cleanup")

    // Agent is gone — steer should throw
    expect(() => {
      manager.steer({
        id: "steer-1",
        agentId: "agent-1",
        message: "test",
        priority: "normal",
        timestamp: new Date(),
      })
    }).toThrow("not managed")
  })
})
