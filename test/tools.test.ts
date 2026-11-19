import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import {
  ANALYTICS_ENGINE, ANALYTICS_REQUEST_REJECTED, AnalyticsError,
} from '../src/errors.ts'
import { SessionRegistry } from '../src/session-registry.ts'
import { createAnalyticsTools } from '../src/tools.ts'

const workdir = await mkdtemp(path.join(import.meta.dirname, '.tmp-tools-'))
await writeFile(
  path.join(workdir, 'sales.csv'),
  ['month,sales', '2026-01,120', '2026-02,140', '2026-03,90', '2026-04,150', '2026-05,60'].join('\n'),
  'utf8',
)

/**
 * Build a stand-in Agent.
 *
 * The tools treat an Agent as an opaque identity (a `Map` key), but the runtime
 * `Agent` type carries the live session and driver face. The assertion is a
 * narrowing downcast: every `Agent` is assignable to `{ id }`, and this suite
 * never touches the rest.
 * @param id - session-backed identity.
 * @returns an Agent carrying only that identity.
 */
function agentOf(id: string): Agent {
  return { id } as Agent
}

/** First conversation. */
const alice = agentOf('session-alice')

/** Second conversation. */
const bob = agentOf('session-bob')

const registry = new SessionRegistry({
  maxMemory: '256MB',
  threads: 1,
  lockConfiguration: true,
  queryTimeoutMs: 5000,
  maxResultRows: 3,
})

const definitions = createAnalyticsTools({ registry, root: workdir, maxFileBytes: 1024 * 1024 })

after(async () => {
  await registry.releaseAll()
  await rm(workdir, { recursive: true, force: true })
})

/**
 * Build the execution identity a tool body needs.
 * @param agent - conversation that owns the call, when any.
 * @param signal - caller cancellation.
 * @returns a tool run context.
 */
function execFor(agent: Agent | undefined, signal = new AbortController().signal): ToolRunContext {
  const common = {
    callId: 'call-1' as ToolCallId,
    rootCallId: 'call-1' as ToolCallId,
    name: 'duckdb_sql',
    arguments: {},
    signal,
    token: Symbol('execution') as ToolExecutionToken,
    deferContext(): void {},
    concludeTurn(): void {},
  }
  return agent === undefined ? common : { ...common, agent }
}

/**
 * Look up one definition by tool name.
 * @param toolName - registered tool name.
 * @returns the definition.
 */
function tool(toolName: string): ToolDefinition {
  const found = definitions.find(definition => definition.name === toolName)
  assert.ok(found !== undefined, `tool ${toolName} is not registered`)
  return found
}

/**
 * Run a tool and return its canonical value plus the model-facing text.
 * @param toolName - registered tool name.
 * @param args - model arguments.
 * @param agent - conversation that owns the call.
 * @returns the canonical value and the rendered text.
 */
async function run(
  toolName: string,
  args: Record<string, unknown>,
  agent: Agent = alice,
): Promise<{ value: JsonValue, text: string }> {
  const definition = tool(toolName)
  const raw = await definition.execute(args, execFor(agent))
  // Round-tripping proves the canonical value is lossless JSON before it is rendered.
  const value: JsonValue = JSON.parse(JSON.stringify(raw))
  const content = definition.output.render(args, value)
  return { value, text: content.map(block => 'text' in block ? block.text : '').join('\n') }
}

/**
 * Read the stable code of a thrown analytics failure.
 * @param error - thrown value.
 * @returns the code, or `undefined` when the value is not an AnalyticsError.
 */
function codeOf(error: unknown): string | undefined {
  return error instanceof AnalyticsError ? error.code : undefined
}

describe('tool registration', () => {
  it('registers the three model-facing tools', () => {
    assert.deepEqual(definitions.map(definition => definition.name), ['duckdb_load', 'duckdb_tables', 'duckdb_sql'])
  })

  it('gives every tool a model-facing description and canonical output schema', () => {
    for (const definition of definitions) {
      assert.ok(definition.description.length > 40, `${definition.name} needs a useful description`)
      assert.ok(definition.output.schema !== undefined)
    }
  })

  it('exposes the supported chart kinds to the model', () => {
    // The projector hands the model raw JSON Schema; read it through JSON.
    const schema = JSON.parse(JSON.stringify(tool('duckdb_sql').parameters)) as {
      properties: { chart: { properties: { type: { enum: string[] } }, required: string[] } }
    }
    assert.deepEqual(schema.properties.chart.properties.type.enum, ['bar', 'line', 'pie'])
    assert.deepEqual(schema.properties.chart.required, ['type', 'x', 'y'])
  })

  it('records a replayable chart payload as presentation metadata', async () => {
    const carol = agentOf('session-carol')
    await run('duckdb_load', { filePath: 'sales.csv' }, carol)
    const args = {
      sql: 'SELECT month, sales FROM sales ORDER BY month',
      chart: { type: 'line', x: 'month', y: 'sales' },
    }
    const definition = tool('duckdb_sql')
    const raw = await definition.execute(args, execFor(carol))
    const value = JSON.parse(JSON.stringify(raw))
    const meta = JSON.parse(JSON.stringify(definition.output.presentationMeta?.(args, value)))
    assert.equal(meta.kind, 'dsh-duckdb-chart')
    assert.equal(meta.version, 1)
    assert.deepEqual(meta.chart, { type: 'line', title: 'sales by month', x: 'month', y: 'sales' })
    assert.equal(meta.points.length, 3, 'the result cap bounds the plotted points')
    assert.equal(meta.points[0].label, '2026-01')
    assert.equal(meta.points[0].value, 120)
    assert.equal(meta.omitted, 0)
    assert.equal(meta.truncated, true)
    await registry.release(carol)
  })

  it('records an empty chart payload when the call asked for no chart', () => {
    const definition = tool('duckdb_sql')
    const meta = definition.output.presentationMeta?.({ sql: 'SELECT 1' }, {
      sql: 'SELECT 1', columns: [], rows: [], rowCount: 0, truncated: false,
    })
    assert.deepEqual(meta, {
      kind: 'dsh-duckdb-chart',
      version: 1,
      chart: null,
      points: [],
      omitted: 0,
      rowCount: 0,
      truncated: false,
    })
  })
})

describe('loading and listing', () => {
  it('imports a file and reports its table', async () => {
    const { value, text } = await run('duckdb_load', { filePath: 'sales.csv' })
    assert.deepEqual(value, {
      table: 'sales',
      source: 'sales.csv',
      rows: 5,
      columns: [{ name: 'month', type: 'VARCHAR' }, { name: 'sales', type: 'BIGINT' }],
      sample: [
        { month: '2026-01', sales: '120' },
        { month: '2026-02', sales: '140' },
        { month: '2026-03', sales: '90' },
        { month: '2026-04', sales: '150' },
        { month: '2026-05', sales: '60' },
      ],
    })
    assert.match(text, /Loaded sales\.csv as table "sales" \(5 rows\)/u)
  })

  it('names a second import of the same file without colliding', async () => {
    const { value } = await run('duckdb_load', { filePath: 'sales.csv' })
    assert.equal((value as { table: string }).table, 'sales_2')
  })

  it('lists what this conversation loaded', async () => {
    const { value, text } = await run('duckdb_tables', {})
    assert.equal((value as { tables: unknown[] }).tables.length, 2)
    assert.match(text, /sales - 5 rows from sales\.csv/u)
  })

  it('does not show one conversation the contents of another', async () => {
    const { value, text } = await run('duckdb_tables', {}, bob)
    assert.deepEqual(value, { tables: [] })
    assert.match(text, /No tables are loaded/u)
  })
})

describe('querying through the tool', () => {
  it('returns rows and draws the requested chart in the card text', async () => {
    const { value, text } = await run('duckdb_sql', {
      sql: 'SELECT month, sales FROM sales ORDER BY month',
      chart: { type: 'bar', x: 'month', y: 'sales' },
    })
    assert.equal((value as { rowCount: number }).rowCount, 3)
    assert.equal((value as { truncated: boolean }).truncated, true)
    assert.match(text, /3 row\(s\) \(truncated by the result cap\)/u)
    assert.match(text, /sales by month/u)
    assert.match(text, /\u2588+.*120/u)
  })

  it('refuses SQL outside the read-only subset', async () => {
    await assert.rejects(
      run('duckdb_sql', { sql: 'DROP TABLE sales' }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
    await assert.rejects(
      run('duckdb_sql', { sql: "SELECT * FROM read_csv_auto('sales.csv')" }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses a chart over a column that does not exist', async () => {
    await assert.rejects(
      run('duckdb_sql', {
        sql: 'SELECT month, sales FROM sales',
        chart: { type: 'bar', x: 'month', y: 'profit' },
      }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses a chart over a column with no numbers', async () => {
    await assert.rejects(
      run('duckdb_sql', {
        sql: "SELECT 'only text' AS label",
        chart: { type: 'bar', x: 'label', y: 'label' },
      }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('needs an owning conversation', async () => {
    await assert.rejects(
      (async () => {
        await tool('duckdb_sql').execute({ sql: 'SELECT 1' }, execFor(undefined))
      })(),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })
})

describe('lifecycle', () => {
  it('starts a conversation over after its database is released', async () => {
    await registry.release(alice)
    const { value } = await run('duckdb_tables', {})
    assert.deepEqual(value, { tables: [] })
  })

  it('refuses new work once the plugin is unloaded', async () => {
    await registry.releaseAll()
    await assert.rejects(
      run('duckdb_tables', {}),
      (error: unknown) => codeOf(error) === ANALYTICS_ENGINE,
    )
  })
})
