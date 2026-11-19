/**
 * Failure vocabulary for the DuckDB analytics tools.
 *
 * Every expected failure carries a stable code so the tool pipeline, policies,
 * and the model can route on `error.code` instead of parsing prose. Only thrown
 * `HarnessError` instances keep `error.name`/`error.code` on the tool result;
 * cancellations deliberately do not use these codes.
 *
 * @module duckdb-analytics/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** A request was rejected before the engine accepted it (bad path, table, or SQL). */
export const ANALYTICS_REQUEST_REJECTED = 'ANALYTICS_REQUEST_REJECTED'

/** A query exceeded its cooperative deadline and was interrupted. */
export const ANALYTICS_TIMEOUT = 'ANALYTICS_TIMEOUT'

/** The database session failed, is closed, or the engine reported an execution error. */
export const ANALYTICS_ENGINE = 'ANALYTICS_ENGINE'

/** Tool-facing failure with a stable machine code. */
export class AnalyticsError extends HarnessError {
  /**
   * @param message - actionable, human-readable description of the failure.
   * @param code - stable code from this module.
   * @param options - optional underlying cause preserved for diagnostics.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/**
 * Build a rejection for input the tool refused before touching the engine.
 * @param message - what was rejected and what the caller may do instead.
 * @returns the coded error to throw.
 */
export function requestRejected(message: string): AnalyticsError {
  return new AnalyticsError(message, ANALYTICS_REQUEST_REJECTED)
}

/**
 * Build a deadline failure.
 * @param timeoutMs - the cooperative budget that elapsed.
 * @returns the coded error to throw.
 */
export function queryTimedOut(timeoutMs: number): AnalyticsError {
  return new AnalyticsError(`Query exceeded its ${timeoutMs} ms budget and was interrupted. Narrow the query.`, ANALYTICS_TIMEOUT)
}

/**
 * Build an engine or lifecycle failure.
 * @param message - actionable description.
 * @param cause - underlying error, when one exists.
 * @returns the coded error to throw.
 */
export function engineFailure(message: string, cause?: unknown): AnalyticsError {
  return new AnalyticsError(message, ANALYTICS_ENGINE, cause === undefined ? undefined : { cause })
}
