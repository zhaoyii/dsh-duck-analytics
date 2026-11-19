/**
 * One in-memory DuckDB database per Agent, and the queries that run on it.
 *
 * The database is created on first use, serializes every statement it runs, and
 * is released when its Agent is disposed. Nothing here is shared between
 * Agents: two conversations cannot see each other's tables even when they load
 * the same file.
 *
 * @module duckdb-analytics/session-database
 */
import { DuckDBInstance, type DuckDBConnection, type DuckDBResultReader } from '@duckdb/node-api'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { DataFile } from './data-files.ts'
import { AnalyticsError, engineFailure, queryTimedOut, requestRejected } from './errors.ts'
import { inspectSql } from './sql-guard.ts'

/** Deployment-varying limits of one session database. */
export interface SessionDatabaseConfig {
  /** DuckDB `max_memory` value, for example `512MB`. */
  readonly maxMemory: string
  /** DuckDB worker thread count for one session database. */
  readonly threads: number
  /** Lock DuckDB configuration so no statement can change it at run time. */
  readonly lockConfiguration: boolean
  /** Cooperative budget for one query. */
  readonly queryTimeoutMs: number
  /** Maximum rows returned to the model per query. */
  readonly maxResultRows: number
}

/** One result column. */
export interface ColumnInfo {
  readonly name: string
  readonly type: string
}

/** One result row, keyed by column name. */
export type ResultRow = Record<string, JsonValue>

/** A bounded query result. */
export interface QueryResult {
  readonly columns: ColumnInfo[]
  readonly rows: ResultRow[]
  /** True when the query produced more rows than the configured cap. */
  readonly truncated: boolean
}

/** A loaded table as the session reports it. */
export interface TableInfo {
  readonly table: string
  readonly rows: number
  /** File name the table was imported from. */
  readonly source: string
}

/** Outcome of importing a file into the session database. */
export interface LoadResult extends TableInfo {
  readonly columns: ColumnInfo[]
  readonly sample: ResultRow[]
}

/** DuckDB reader per supported file format. */
const READERS = { csv: 'read_csv_auto', parquet: 'read_parquet', json: 'read_json_auto' } as const

/** Quoted identifier, rejecting anything that is not a plain lowercase name. */
function identifier(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw engineFailure(`Refusing to use "${name}" as a table name.`)
  }
  return `"${name}"`
}

/** Single-quoted SQL string literal; DuckDB strings take no backslash escapes. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Absolute Windows path to the forward-slash form DuckDB accepts. */
function sqlPath(absolutePath: string): string {
  return literal(absolutePath.replaceAll('\\', '/'))
}

/** One live session database. */
export class SessionDatabase {
  readonly #instance: DuckDBInstance
  readonly #connection: DuckDBConnection
  readonly #config: SessionDatabaseConfig
  /** Table name to source file name, for `duckdb_tables` reporting. */
  readonly #sources = new Map<string, string>()
  /** Serializes statements; a DuckDB connection is not reentrant. */
  #serial: Promise<unknown> = Promise.resolve()
  #closed = false

  private constructor(instance: DuckDBInstance, connection: DuckDBConnection, config: SessionDatabaseConfig) {
    this.#instance = instance
    this.#connection = connection
    this.#config = config
  }

  /**
   * Create the database and apply its resource limits.
   * @param config - deployment limits.
   * @returns the open database.
   */
  static async open(config: SessionDatabaseConfig): Promise<SessionDatabase> {
    const instance = await DuckDBInstance.create(':memory:')
    const connection = await instance.connect()
    const database = new SessionDatabase(instance, connection, config)
    try {
      await connection.run(`SET max_memory = ${literal(config.maxMemory)}`)
      await connection.run(`SET threads = ${Math.max(1, Math.trunc(config.threads))}`)
      if (config.lockConfiguration) await connection.run('SET lock_configuration = true')
    } catch (error) {
      await database.close()
      throw engineFailure('DuckDB rejected the configured resource limits.', error)
    }
    return database
  }

  /** Run one unit of work after every earlier statement on this connection. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(work, work)
    this.#serial = result.then(() => undefined, () => undefined)
    return result
  }

  /** Reject use after the owning Agent was disposed. */
  #assertOpen(): void {
    if (this.#closed) throw engineFailure('The analytics database for this conversation is closed.')
  }

  /**
   * Import a validated file as a new table.
   * @param file - resolved file.
   * @param table - collision-free table name.
   * @param signal - caller cancellation.
   * @returns the table, its columns, its row count, and a sample.
   */
  async load(file: DataFile, table: string, signal: AbortSignal): Promise<LoadResult> {
    return this.#enqueue(async () => {
      this.#assertOpen()
      const quoted = identifier(table)
      try {
        await this.#run(`CREATE TABLE ${quoted} AS SELECT * FROM ${READERS[file.format]}(${sqlPath(file.absolutePath)})`, signal)
      } catch (error) {
        if (error instanceof AnalyticsError || signal.aborted) throw error
        throw requestRejected(`Could not load "${file.displayName}": ${messageOf(error)}`)
      }
      this.#sources.set(table, file.displayName)
      const columns = await this.#describe(table)
      const rows = await this.#count(table)
      const sample = await this.#sample(table, columns)
      return { table, rows, source: file.displayName, columns, sample }
    })
  }

  /**
   * Run one admitted read-only query.
   * @param sql - model-authored SQL.
   * @param signal - caller cancellation.
   * @returns the bounded result.
   */
  async query(sql: string, signal: AbortSignal): Promise<QueryResult> {
    return this.#enqueue(async () => {
      this.#assertOpen()
      const admission = inspectSql(sql)
      if (admission.violations.length > 0) throw requestRejected(admission.violations.join(' '))
      if (admission.statement === '') throw requestRejected('SQL is empty.')

      let count: number
      try {
        // DuckDB's own parser decides how many statements the text holds.
        count = (await this.#connection.extractStatements(admission.statement)).count
      } catch (error) {
        throw requestRejected(`SQL does not parse: ${messageOf(error)}`)
      }
      if (count !== 1) throw requestRejected('Exactly one statement may be sent per call.')

      const cap = this.#config.maxResultRows
      const wrapped = `SELECT * FROM (${admission.statement}) AS "_dsh_result" LIMIT ${cap + 1}`
      let reader: DuckDBResultReader
      try {
        reader = await this.#run(wrapped, signal)
      } catch (error) {
        if (error instanceof AnalyticsError || signal.aborted) throw error
        throw requestRejected(`Query failed: ${messageOf(error)}`)
      }

      const rows = reader.getRowObjectsJson()
      const columns = reader.columnNames().map((name, index) => ({
        name,
        type: reader.columnTypes()[index]?.toString() ?? 'UNKNOWN',
      }))
      return { columns, rows: rows.slice(0, cap), truncated: rows.length > cap }
    })
  }

  /**
   * List the tables currently loaded in this conversation.
   * @returns one entry per table, in load order.
   */
  async tables(): Promise<TableInfo[]> {
    return this.#enqueue(async () => {
      this.#assertOpen()
      const result: TableInfo[] = []
      for (const [table, source] of this.#sources) {
        result.push({ table, rows: await this.#count(table), source })
      }
      return result
    })
  }

  /** Close the connection and the instance, letting one in-flight statement settle first. */
  async close(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) return
      this.#closed = true
      const connection = this.#connection
      const instance = this.#instance
      try {
        connection.interrupt()
      } catch {
        // A connection with nothing running may reject the interrupt; closing still applies.
      }
      connection.closeSync()
      instance.closeSync()
    })
  }

  /**
   * Run one statement with a cooperative deadline and caller cancellation.
   * @param sql - host-authored statement.
   * @param signal - caller cancellation, forwarded to a native interrupt.
   * @returns the materialized reader.
   */
  async #run(sql: string, signal: AbortSignal): Promise<DuckDBResultReader> {
    const timeoutMs = this.#config.queryTimeoutMs
    let timedOut = false
    const abort = (): void => {
      this.#connection.interrupt()
    }
    const timer = setTimeout(() => {
      timedOut = true
      abort()
    }, timeoutMs)
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await this.#connection.runAndReadAll(sql)
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
      }
      if (timedOut) throw queryTimedOut(timeoutMs)
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  /** Describe a table's columns. */
  async #describe(table: string): Promise<ColumnInfo[]> {
    const reader = await this.#connection.runAndReadAll(`DESCRIBE ${identifier(table)}`)
    return reader.getRowObjects().map(row => ({
      name: String(row['column_name'] ?? ''),
      type: String(row['column_type'] ?? 'UNKNOWN'),
    }))
  }

  /** Exact row count of a table. */
  async #count(table: string): Promise<number> {
    const reader = await this.#connection.runAndReadAll(`SELECT count(*) AS rows FROM ${identifier(table)}`)
    const value = reader.getRowObjectsJson()[0]?.['rows']
    return typeof value === 'number' ? value : Number(value ?? 0)
  }

  /** First rows of a table, for the load confirmation. */
  async #sample(table: string, columns: readonly ColumnInfo[]): Promise<Record<string, JsonValue>[]> {
    const limit = 5
    const reader = await this.#connection.runAndReadAll(`SELECT * FROM ${identifier(table)} LIMIT ${limit}`)
    const rows = reader.getRowObjectsJson()
    return rows.map(row => Object.fromEntries(columns.map(column => [column.name, row[column.name] ?? null])))
  }
}

/**
 * Extract a readable message from a native engine error.
 * @param error - thrown value.
 * @returns the message without the native `Error: ` envelope.
 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error:\s*/u, '').split('\n')[0] ?? text
}
