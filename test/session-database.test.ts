import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { resolveDataFile } from '../src/data-files.ts'
import {
  ANALYTICS_ENGINE, ANALYTICS_REQUEST_REJECTED, ANALYTICS_TIMEOUT, AnalyticsError,
} from '../src/errors.ts'
import { SessionDatabase, type SessionDatabaseConfig } from '../src/session-database.ts'

const workdir = await mkdtemp(path.join(import.meta.dirname, '.tmp-db-'))
const root = workdir
await writeFile(
  path.join(root, 'sales.csv'),
  ['month,sales', '2026-01,120', '2026-02,140', '2026-03,90', '2026-04,150', '2026-05,60'].join('\n'),
  'utf8',
)

const CONFIG: SessionDatabaseConfig = {
  maxMemory: '256MB',
  threads: 1,
  lockConfiguration: true,
  queryTimeoutMs: 5000,
  maxResultRows: 3,
}

const openDatabases: SessionDatabase[] = []

/**
 * Open a database that the suite closes afterwards.
 * @param overrides - configuration changes for this database.
 * @returns the open database.
 */
async function open(overrides: Partial<SessionDatabaseConfig> = {}): Promise<SessionDatabase> {
  const database = await SessionDatabase.open({ ...CONFIG, ...overrides })
  openDatabases.push(database)
  return database
}

/**
 * Load the fixture CSV into a database.
 * @param database - target database.
 * @param signal - caller cancellation.
 * @returns the load outcome.
 */
async function loadSales(database: SessionDatabase, signal = new AbortController().signal) {
  const file = await resolveDataFile({ root, input: 'sales.csv', maxBytes: 1024 * 1024 })
  return database.load(file, 'sales', signal)
}

after(async () => {
  await Promise.all(openDatabases.map(database => database.close()))
  await rm(workdir, { recursive: true, force: true })
})

/**
 * Read the stable code of a thrown analytics failure.
 * @param error - thrown value.
 * @returns the code, or `undefined` when the value is not an AnalyticsError.
 */
function codeOf(error: unknown): string | undefined {
  return error instanceof AnalyticsError ? error.code : undefined
}

describe('importing a file', () => {
  it('creates a typed table and reports its schema', async () => {
    const database = await open()
    const loaded = await loadSales(database)
    assert.equal(loaded.table, 'sales')
    assert.equal(loaded.source, 'sales.csv')
    assert.equal(loaded.rows, 5)
    assert.deepEqual(loaded.columns, [
      { name: 'month', type: 'VARCHAR' },
      { name: 'sales', type: 'BIGINT' },
    ])
    assert.deepEqual(loaded.sample[0], { month: '2026-01', sales: '120' })
  })

  it('refuses to load the same table name twice', async () => {
    const database = await open()
    await loadSales(database)
    await assert.rejects(loadSales(database), (error: unknown) => {
      assert.equal(codeOf(error), ANALYTICS_REQUEST_REJECTED)
      return true
    })
  })
})

describe('querying', () => {
  it('returns typed columns, rows, and a truncation flag', async () => {
    const database = await open()
    await loadSales(database)
    const result = await database.query('SELECT month, sales FROM sales ORDER BY month', new AbortController().signal)
    assert.deepEqual(result.columns, [
      { name: 'month', type: 'VARCHAR' },
      { name: 'sales', type: 'BIGINT' },
    ])
    assert.equal(result.rows.length, 3)
    assert.equal(result.truncated, true)
    assert.deepEqual(result.rows[0], { month: '2026-01', sales: '120' })
  })

  it('does not flag truncation when the result fits', async () => {
    const database = await open()
    await loadSales(database)
    const result = await database.query('SELECT count(*) AS n FROM sales', new AbortController().signal)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.rows, [{ n: '5' }])
  })

  it('runs a CTE', async () => {
    const database = await open()
    await loadSales(database)
    const result = await database.query(
      'WITH top AS (SELECT max(sales) AS best FROM sales) SELECT best FROM top',
      new AbortController().signal,
    )
    assert.deepEqual(result.rows, [{ best: '150' }])
  })

  it('refuses a second statement', async () => {
    const database = await open()
    await loadSales(database)
    await assert.rejects(
      database.query('SELECT 1; DROP TABLE sales', new AbortController().signal),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses file readers even though the engine could run them', async () => {
    const database = await open()
    await assert.rejects(
      database.query("SELECT * FROM read_csv_auto('sales.csv')", new AbortController().signal),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('reports a parse or binder failure as a request rejection', async () => {
    const database = await open()
    await assert.rejects(
      database.query('SELECT * FROM missing_table', new AbortController().signal),
      (error: unknown) => {
        assert.equal(codeOf(error), ANALYTICS_REQUEST_REJECTED)
        assert.match(String((error as Error).message), /missing_table/u)
        return true
      },
    )
  })

  it('interrupts a query that exceeds its deadline', async () => {
    const database = await open({ queryTimeoutMs: 40 })
    await assert.rejects(
      database.query('SELECT count(*) FROM range(100000000000)', new AbortController().signal),
      (error: unknown) => codeOf(error) === ANALYTICS_TIMEOUT,
    )
    // The connection survives an interrupt, so later calls still work.
    const result = await database.query('SELECT 42 AS v', new AbortController().signal)
    assert.deepEqual(result.rows, [{ v: 42 }])
  })

  it('aborts an in-flight query when the caller cancels', async () => {
    const database = await open({ queryTimeoutMs: 30_000 })
    const controller = new AbortController()
    const running = database.query('SELECT count(*) FROM range(100000000000)', controller.signal)
    setTimeout(() => controller.abort(new Error('caller cancelled')), 30)
    await assert.rejects(running, (error: unknown) => String((error as Error).message) === 'caller cancelled')
  })
})

describe('isolation and lifecycle', () => {
  it('keeps two conversation databases apart', async () => {
    const first = await open()
    const second = await open()
    await loadSales(first)
    assert.equal((await first.tables()).length, 1)
    assert.deepEqual(await second.tables(), [])
    await assert.rejects(
      second.query('SELECT * FROM sales', new AbortController().signal),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('reports loaded table names and row counts', async () => {
    const database = await open()
    await loadSales(database)
    assert.deepEqual(await database.tables(), [{ table: 'sales', rows: 5, source: 'sales.csv' }])
  })

  it('refuses work after it is closed', async () => {
    const database = await open()
    await database.close()
    await assert.rejects(
      database.query('SELECT 1', new AbortController().signal),
      (error: unknown) => codeOf(error) === ANALYTICS_ENGINE,
    )
    // A repeated close is a no-op rather than a failure.
    await database.close()
  })
})
