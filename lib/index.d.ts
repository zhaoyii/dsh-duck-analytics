/**
 * DuckDB analytics tools for one DeepSeek Harness conversation.
 *
 * The plugin is the deployment-scoped half: it validates configuration, owns the
 * registry that hands every Agent its own in-memory database, and registers the
 * tools once. Per-conversation state is resolved from `exec.agent` at call time
 * and released when that Agent is disposed.
 *
 * @module duckdb-analytics
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "duckdb-analytics";
export declare const inject: string[];
/** Plugin configuration; every deployment-varying limit is settable from `cordis.yml`. */
export interface Config {
    /** Directory that model-supplied relative file paths resolve inside. */
    dataRoot: string;
    /** Largest file the import step may read. */
    maxFileBytes: number;
    /** Largest row count returned to the model by one query. */
    maxResultRows: number;
    /** Cooperative deadline for one statement. */
    queryTimeoutMs: number;
    /** DuckDB `max_memory` for one conversation database. */
    maxMemory: string;
    /** DuckDB worker threads for one conversation database. */
    threads: number;
    /** Lock DuckDB configuration so no statement can change limits at run time. */
    lockConfiguration: boolean;
}
export declare const Config: Schema<Config>;
/**
 * Register the analytics tools and own the per-Agent databases.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
