import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { resolveDataFile, resolveDataRoot, tableNameFor, SUPPORTED_FORMATS } from '../src/data-files.ts'
import { ANALYTICS_ENGINE, ANALYTICS_REQUEST_REJECTED, AnalyticsError } from '../src/errors.ts'

const workdir = await mkdtemp(path.join(import.meta.dirname, '.tmp-files-'))
const root = path.join(workdir, 'data')
await mkdir(path.join(root, 'nested'), { recursive: true })
await writeFile(path.join(root, 'sales.csv'), 'month,sales\n2026-01,120\n', 'utf8')
await writeFile(path.join(root, 'nested', 'small.parquet'), 'x', 'utf8')
await writeFile(path.join(root, 'big.csv'), 'x'.repeat(2048), 'utf8')
await writeFile(path.join(root, 'notes.txt'), 'x', 'utf8')
await writeFile(path.join(workdir, 'outside.csv'), 'month,sales\n', 'utf8')

after(async () => {
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

describe('data root resolution', () => {
  it('resolves a configured directory', async () => {
    assert.equal(await resolveDataRoot(root), path.resolve(root))
  })

  it('fails at load for a missing directory', async () => {
    await assert.rejects(resolveDataRoot(path.join(workdir, 'absent')), (error: unknown) => {
      assert.equal(codeOf(error), ANALYTICS_ENGINE)
      return true
    })
  })
})

describe('data file admission', () => {
  it('accepts a relative path inside the root', async () => {
    const file = await resolveDataFile({ root, input: 'sales.csv', maxBytes: 1024 })
    assert.equal(file.displayName, 'sales.csv')
    assert.equal(file.format, 'csv')
    assert.equal(file.bytes, 24)
  })

  it('accepts a nested relative path', async () => {
    const file = await resolveDataFile({ root, input: 'nested/small.parquet', maxBytes: 1024 })
    assert.equal(file.format, 'parquet')
  })

  it('refuses an absolute path', async () => {
    await assert.rejects(
      resolveDataFile({ root, input: path.join(root, 'sales.csv'), maxBytes: 1024 }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses a path that escapes the root', async () => {
    await assert.rejects(
      resolveDataFile({ root, input: '../outside.csv', maxBytes: 1024 }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses a missing file', async () => {
    await assert.rejects(
      resolveDataFile({ root, input: 'absent.csv', maxBytes: 1024 }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses an unsupported extension', async () => {
    await assert.rejects(
      resolveDataFile({ root, input: 'notes.txt', maxBytes: 1024 }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses a file above the size limit', async () => {
    await assert.rejects(
      resolveDataFile({ root, input: 'big.csv', maxBytes: 1024 }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('refuses a symlink that leaves the root', async (context) => {
    const link = path.join(root, 'linked.csv')
    try {
      await symlink(path.join(workdir, 'outside.csv'), link)
    } catch {
      // Creating symbolic links needs a privilege this host may withhold.
      context.skip('symbolic links are not permitted on this host')
      return
    }
    await assert.rejects(
      resolveDataFile({ root, input: 'linked.csv', maxBytes: 1024 }),
      (error: unknown) => codeOf(error) === ANALYTICS_REQUEST_REJECTED,
    )
  })

  it('documents exactly the formats the engine can read', () => {
    assert.deepEqual([...SUPPORTED_FORMATS.keys()], ['.csv', '.parquet', '.json'])
  })
})

describe('table naming', () => {
  it('normalizes a file stem into an identifier', () => {
    assert.equal(tableNameFor('Sales 2026.csv', new Set()), 'sales_2026')
  })

  it('prefixes a stem that would start with a digit', () => {
    assert.equal(tableNameFor('2026.csv', new Set()), 't_2026')
  })

  it('suffixes collisions', () => {
    assert.equal(tableNameFor('sales.csv', new Set(['sales'])), 'sales_2')
    assert.equal(tableNameFor('sales.csv', new Set(['sales', 'sales_2'])), 'sales_3')
  })
})
