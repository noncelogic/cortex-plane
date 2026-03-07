/**
 * ExecutionRegistry — process-singleton that tracks in-flight execution
 * handles by job ID. Enables the kill-switch API to cancel running jobs
 * without polling the database.
 *
 * Handles are registered at execution start and unregistered on completion
 * (or cancellation). The registry is intentionally in-process; horizontal
 * scaling uses the database-backed cancel checker as a fallback.
 */

import type { ExecutionHandle } from "@cortex/shared/backends"

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ExecutionRegistry {
  private readonly handles = new Map<string, ExecutionHandle>()

  /**
   * Register an execution handle for a running job.
   */
  register(jobId: string, handle: ExecutionHandle): void {
    this.handles.set(jobId, handle)
  }

  /**
   * Remove a handle when the job completes (success, failure, or cancellation).
   */
  unregister(jobId: string): void {
    this.handles.delete(jobId)
  }

  /**
   * Cancel a running job by invoking the handle's `cancel()` method.
   * Returns `true` if the job was found and cancelled, `false` otherwise.
   */
  async cancel(jobId: string, reason: string): Promise<boolean> {
    const handle = this.handles.get(jobId)
    if (!handle) return false
    await handle.cancel(reason)
    return true
  }

  /**
   * Return the IDs of all currently running jobs.
   */
  getRunningJobIds(): string[] {
    return [...this.handles.keys()]
  }

  /**
   * Number of currently tracked executions.
   */
  get size(): number {
    return this.handles.size
  }
}
