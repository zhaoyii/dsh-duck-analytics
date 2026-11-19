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
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { resolveDataRoot } from './data-files.ts'
import { SessionRegistry } from './session-registry.ts'
import { createAnalyticsTools } from './tools.ts'

export const name = 'duckdb-analytics'
export const inject = ['tools']

/** Plugin configuration; every deployment-varying limit is settable from `cordis.yml`. */
export interface Config {
  /** Directory that model-supplied relative file paths resolve inside. */
  dataRoot: string
  /** Largest file the import step may read. */
  maxFileBytes: number
  /** Largest row count returned to the model by one query. */
  maxResultRows: number
  /** Cooperative deadline for one statement. */
  queryTimeoutMs: number
  /** DuckDB `max_memory` for one conversation database. */
  maxMemory: string
  /** DuckDB worker threads for one conversation database. */
  threads: number
  /** Lock DuckDB configuration so no statement can change limits at run time. */
  lockConfiguration: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataRoot: Schema.string().required().description('Directory that model file paths resolve inside.'),
  maxFileBytes: Schema.number().default(32 * 1024 * 1024).description('Largest importable file, in bytes.'),
  maxResultRows: Schema.number().default(100).description('Largest row count returned to the model.'),
  queryTimeoutMs: Schema.number().default(15_000).description('Cooperative deadline for one statement.'),
  maxMemory: Schema.string().default('512MB').description('DuckDB memory limit per conversation.'),
  threads: Schema.number().default(2).description('DuckDB worker threads per conversation.'),
  lockConfiguration: Schema.boolean().default(true).description('Forbid run-time DuckDB settings changes.'),
})

/**
 * Register the analytics tools and own the per-Agent databases.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = await resolveDataRoot(config.dataRoot)
  const registry = new SessionRegistry({
    maxMemory: config.maxMemory,
    threads: config.threads,
    lockConfiguration: config.lockConfiguration,
    queryTimeoutMs: config.queryTimeoutMs,
    maxResultRows: config.maxResultRows,
  })

  ctx.effect(() => () => {
    void registry.releaseAll()
  }, 'duckdb-analytics: session databases')

  ctx.on('agent/disposed', ({ agent }) => {
    void registry.release(agent)
  })

  for (const definition of createAnalyticsTools({ registry, root, maxFileBytes: config.maxFileBytes })) {
    ctx.tools.register(definition)
  }
}
