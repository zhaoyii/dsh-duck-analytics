import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inspectSql } from '../src/sql-guard.ts'

/**
 * Assert that a statement is admitted.
 * @param sql - candidate statement.
 * @returns the inspected statement text.
 */
function admitted(sql: string): string {
  const result = inspectSql(sql)
  assert.deepEqual(result.violations, [], `expected ${sql} to be admitted`)
  return result.statement
}

/**
 * Assert that a statement is refused.
 * @param sql - candidate statement.
 * @returns the reported violations.
 */
function refused(sql: string): string[] {
  const result = inspectSql(sql)
  assert.ok(result.violations.length > 0, `expected ${sql} to be refused`)
  return result.violations
}

describe('read-only admission', () => {
  it('admits a plain SELECT', () => {
    assert.equal(admitted('SELECT * FROM sales'), 'SELECT * FROM sales')
  })

  it('admits WITH ... SELECT and keeps its text', () => {
    assert.equal(
      admitted('WITH x AS (SELECT 1 AS v) SELECT * FROM x'),
      'WITH x AS (SELECT 1 AS v) SELECT * FROM x',
    )
  })

  it('admits string literals in value position', () => {
    admitted("SELECT * FROM sales WHERE month = '2026-01'")
    admitted("SELECT * FROM sales WHERE note = 'a, b'")
    admitted("SELECT * FROM sales WHERE note = 'DROP TABLE sales'")
  })

  it('admits identifiers that spell keywords or reader names', () => {
    admitted('SELECT set, cast, read_sales FROM sales')
    admitted('SELECT * FROM read_sales')
    admitted('SELECT count(*) AS n, sum(amount) AS total FROM sales GROUP BY month')
  })

  it('strips trailing terminators and comments from the embeddable statement', () => {
    assert.equal(admitted('SELECT 1 ;;  '), 'SELECT 1')
    assert.equal(admitted('SELECT 1; -- trailing note'), 'SELECT 1')
  })

  it('refuses an empty statement', () => {
    refused('')
    refused('   -- only a comment')
  })

  it('refuses anything that does not start with SELECT or WITH', () => {
    refused('DROP TABLE sales')
    refused('INSERT INTO sales VALUES (1)')
    refused('COPY sales TO \'out.csv\'')
    refused('ATTACH \'other.db\' AS other')
    refused('SET threads = 8')
    refused('PRAGMA database_list')
  })

  it('refuses a second statement', () => {
    refused('SELECT 1; DROP TABLE sales')
    refused('SELECT 1; SELECT 2')
  })

  it('refuses a string literal where a table belongs', () => {
    refused("SELECT * FROM 'sales.csv'")
    refused("SELECT * FROM sales, 'other.csv'")
    refused("SELECT * FROM (SELECT * FROM 'nested.csv') AS t")
    refused("SELECT * FROM sales JOIN 'other.csv' AS o ON true")
  })

  it('refuses file and network reader functions in call position', () => {
    refused("SELECT * FROM read_csv_auto('sales.csv')")
    refused("SELECT read_parquet('sales.parquet')")
    refused("SELECT read_text('secrets.txt')")
    refused("SELECT * FROM glob('*')")
    refused("SELECT * FROM parquet_scan('sales.parquet')")
    refused("SELECT * FROM sniff_csv('sales.csv')")
  })

  it('refuses reader calls hidden behind comments or mixed case', () => {
    refused("SELECT * FROM READ_CSV_auto('sales.csv')")
    refused("SELECT * FROM /* inline */ read_csv_auto('sales.csv')")
  })
})
