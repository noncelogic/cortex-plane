/**
 * Proactive Credential Refresh Task
 *
 * Graphile Worker scheduled task that refreshes OAuth tokens before they
 * expire, rather than relying solely on just-in-time refresh during execution.
 *
 * Schedule: every 15 minutes via cron
 * Logic:
 *   1. Refresh OAuth tokens expiring within 30 minutes
 *   2. Emit rotation_due audit events for stale tool secrets (90+ days)
 *
 * @see https://github.com/noncelogic/cortex-plane/issues/280
 */

import type { JobHelpers, Task } from "graphile-worker"
import type { Kysely } from "kysely"

import { CredentialService } from "../../auth/credential-service.js"
import type { AuthOAuthConfig } from "../../config.js"
import type { Database } from "../../db/types.js"

export function createCredentialRefreshTask(
  db: Kysely<Database>,
  authConfig: AuthOAuthConfig,
): Task {
  const credentialService = new CredentialService(db, authConfig)

  return async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    const { refreshed, failed } = await credentialService.refreshExpiring()

    if (refreshed > 0 || failed > 0) {
      helpers.logger.info(`credential_refresh: Refreshed ${refreshed} tokens, ${failed} failures`)
    }

    // Stretch goal: rotation reminders for stale tool secrets
    const rotationDue = await credentialService.emitRotationReminders()
    if (rotationDue > 0) {
      helpers.logger.info(`credential_refresh: ${rotationDue} tool secret(s) due for rotation`)
    }
  }
}
