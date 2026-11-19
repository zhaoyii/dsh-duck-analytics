import Schema from '@deepseek-ai/schemastery';
import { resolveDataRoot } from "./data-files.js";
import { SessionRegistry } from "./session-registry.js";
import { createAnalyticsTools } from "./tools.js";
export const name = 'duckdb-analytics';
export const inject = ['tools'];
export const Config = Schema.object({
    dataRoot: Schema.string().required().description('Directory that model file paths resolve inside.'),
    maxFileBytes: Schema.number().default(32 * 1024 * 1024).description('Largest importable file, in bytes.'),
    maxResultRows: Schema.number().default(100).description('Largest row count returned to the model.'),
    queryTimeoutMs: Schema.number().default(15_000).description('Cooperative deadline for one statement.'),
    maxMemory: Schema.string().default('512MB').description('DuckDB memory limit per conversation.'),
    threads: Schema.number().default(2).description('DuckDB worker threads per conversation.'),
    lockConfiguration: Schema.boolean().default(true).description('Forbid run-time DuckDB settings changes.'),
});
/**
 * Register the analytics tools and own the per-Agent databases.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export async function apply(ctx, config) {
    const root = await resolveDataRoot(config.dataRoot);
    const registry = new SessionRegistry({
        maxMemory: config.maxMemory,
        threads: config.threads,
        lockConfiguration: config.lockConfiguration,
        queryTimeoutMs: config.queryTimeoutMs,
        maxResultRows: config.maxResultRows,
    });
    ctx.effect(() => () => {
        void registry.releaseAll();
    }, 'duckdb-analytics: session databases');
    ctx.on('agent/disposed', ({ agent }) => {
        void registry.release(agent);
    });
    for (const definition of createAnalyticsTools({ registry, root, maxFileBytes: config.maxFileBytes })) {
        ctx.tools.register(definition);
    }
}
