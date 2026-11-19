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
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** A request was rejected before the engine accepted it (bad path, table, or SQL). */
export declare const ANALYTICS_REQUEST_REJECTED = "ANALYTICS_REQUEST_REJECTED";
/** A query exceeded its cooperative deadline and was interrupted. */
export declare const ANALYTICS_TIMEOUT = "ANALYTICS_TIMEOUT";
/** The database session failed, is closed, or the engine reported an execution error. */
export declare const ANALYTICS_ENGINE = "ANALYTICS_ENGINE";
/** Tool-facing failure with a stable machine code. */
export declare class AnalyticsError extends HarnessError {
    /**
     * @param message - actionable, human-readable description of the failure.
     * @param code - stable code from this module.
     * @param options - optional underlying cause preserved for diagnostics.
     */
    constructor(message: string, code: string, options?: ErrorOptions);
}
/**
 * Build a rejection for input the tool refused before touching the engine.
 * @param message - what was rejected and what the caller may do instead.
 * @returns the coded error to throw.
 */
export declare function requestRejected(message: string): AnalyticsError;
/**
 * Build a deadline failure.
 * @param timeoutMs - the cooperative budget that elapsed.
 * @returns the coded error to throw.
 */
export declare function queryTimedOut(timeoutMs: number): AnalyticsError;
/**
 * Build an engine or lifecycle failure.
 * @param message - actionable description.
 * @param cause - underlying error, when one exists.
 * @returns the coded error to throw.
 */
export declare function engineFailure(message: string, cause?: unknown): AnalyticsError;
