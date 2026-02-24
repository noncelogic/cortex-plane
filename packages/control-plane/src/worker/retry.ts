/**
 * Retry strategy for application-level retries.
 * Exponential backoff with ±25% jitter to prevent thundering herd.
 *
 * This is independent of Graphile Worker's internal retry mechanism
 * (which uses exp(least(10, attempt)) seconds). Our retries create
 * new Worker jobs with a calculated runAt.
 */

export interface RetryConfig {
  /** Base delay in milliseconds. Default: 1000 (1 second). */
  baseDelayMs: number
  /** Maximum delay in milliseconds. Default: 300_000 (5 minutes). */
  maxDelayMs: number
  /** Multiplier applied per retry attempt. Default: 2. */
  multiplier: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  multiplier: 2,
}

/**
 * Calculate the retry delay for a given attempt number.
 * Uses exponential backoff with ±25% jitter randomization.
 *
 * @param attempt - The attempt number (0-based: first retry = 0)
 * @param config - Retry configuration overrides
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(config.multiplier, attempt)
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs)

  // ±25% jitter: multiply by a random factor between 0.75 and 1.25
  const jitterFactor = 0.75 + Math.random() * 0.5
  return Math.round(cappedDelay * jitterFactor)
}

/**
 * Calculate the runAt date for Graphile Worker's job scheduling.
 * Returns a Date offset from now by the calculated retry delay.
 *
 * @param attempt - The attempt number (0-based)
 * @param config - Retry configuration overrides
 * @returns Date when the retry should be executed
 */
export function calculateRunAt(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): Date {
  const delayMs = calculateRetryDelay(attempt, config)
  return new Date(Date.now() + delayMs)
}
