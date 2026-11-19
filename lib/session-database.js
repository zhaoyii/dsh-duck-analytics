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
import { DuckDBInstance } from '@duckdb/node-api';
import { AnalyticsError, engineFailure, queryTimedOut, requestRejected } from "./errors.js";
import { inspectSql } from "./sql-guard.js";
/** DuckDB reader per supported file format. */
const READERS = { csv: 'read_csv_auto', parquet: 'read_parquet', json: 'read_json_auto' };
/** Quoted identifier, rejecting anything that is not a plain lowercase name. */
function identifier(name) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        throw engineFailure(`Refusing to use "${name}" as a table name.`);
    }
    return `"${name}"`;
}
/** Single-quoted SQL string literal; DuckDB strings take no backslash escapes. */
function literal(value) {
    return `'${value.replaceAll("'", "''")}'`;
}
/** Absolute Windows path to the forward-slash form DuckDB accepts. */
function sqlPath(absolutePath) {
    return literal(absolutePath.replaceAll('\\', '/'));
}
/** One live session database. */
export class SessionDatabase {
    #instance;
    #connection;
    #config;
    /** Table name to source file name, for `duckdb_tables` reporting. */
    #sources = new Map();
    /** Serializes statements; a DuckDB connection is not reentrant. */
    #serial = Promise.resolve();
    #closed = false;
    constructor(instance, connection, config) {
        this.#instance = instance;
        this.#connection = connection;
        this.#config = config;
    }
    /**
     * Create the database and apply its resource limits.
     * @param config - deployment limits.
     * @returns the open database.
     */
    static async open(config) {
        const instance = await DuckDBInstance.create(':memory:');
        const connection = await instance.connect();
        const database = new SessionDatabase(instance, connection, config);
        try {
            await connection.run(`SET max_memory = ${literal(config.maxMemory)}`);
            await connection.run(`SET threads = ${Math.max(1, Math.trunc(config.threads))}`);
            if (config.lockConfiguration)
                await connection.run('SET lock_configuration = true');
        }
        catch (error) {
            await database.close();
            throw engineFailure('DuckDB rejected the configured resource limits.', error);
        }
        return database;
    }
    /** Run one unit of work after every earlier statement on this connection. */
    #enqueue(work) {
        const result = this.#serial.then(work, work);
        this.#serial = result.then(() => undefined, () => undefined);
        return result;
    }
    /** Reject use after the owning Agent was disposed. */
    #assertOpen() {
        if (this.#closed)
            throw engineFailure('The analytics database for this conversation is closed.');
    }
    /**
     * Import a validated file as a new table.
     * @param file - resolved file.
     * @param table - collision-free table name.
     * @param signal - caller cancellation.
     * @returns the table, its columns, its row count, and a sample.
     */
    async load(file, table, signal) {
        return this.#enqueue(async () => {
            this.#assertOpen();
            const quoted = identifier(table);
            try {
                await this.#run(`CREATE TABLE ${quoted} AS SELECT * FROM ${READERS[file.format]}(${sqlPath(file.absolutePath)})`, signal);
            }
            catch (error) {
                if (error instanceof AnalyticsError || signal.aborted)
                    throw error;
                throw requestRejected(`Could not load "${file.displayName}": ${messageOf(error)}`);
            }
            this.#sources.set(table, file.displayName);
            const columns = await this.#describe(table);
            const rows = await this.#count(table);
            const sample = await this.#sample(table, columns);
            return { table, rows, source: file.displayName, columns, sample };
        });
    }
    /**
     * Run one admitted read-only query.
     * @param sql - model-authored SQL.
     * @param signal - caller cancellation.
     * @returns the bounded result.
     */
    async query(sql, signal) {
        return this.#enqueue(async () => {
            this.#assertOpen();
            const admission = inspectSql(sql);
            if (admission.violations.length > 0)
                throw requestRejected(admission.violations.join(' '));
            if (admission.statement === '')
                throw requestRejected('SQL is empty.');
            let count;
            try {
                // DuckDB's own parser decides how many statements the text holds.
                count = (await this.#connection.extractStatements(admission.statement)).count;
            }
            catch (error) {
                throw requestRejected(`SQL does not parse: ${messageOf(error)}`);
            }
            if (count !== 1)
                throw requestRejected('Exactly one statement may be sent per call.');
            const cap = this.#config.maxResultRows;
            const wrapped = `SELECT * FROM (${admission.statement}) AS "_dsh_result" LIMIT ${cap + 1}`;
            let reader;
            try {
                reader = await this.#run(wrapped, signal);
            }
            catch (error) {
                if (error instanceof AnalyticsError || signal.aborted)
                    throw error;
                throw requestRejected(`Query failed: ${messageOf(error)}`);
            }
            const rows = reader.getRowObjectsJson();
            const columns = reader.columnNames().map((name, index) => ({
                name,
                type: reader.columnTypes()[index]?.toString() ?? 'UNKNOWN',
            }));
            return { columns, rows: rows.slice(0, cap), truncated: rows.length > cap };
        });
    }
    /**
     * List the tables currently loaded in this conversation.
     * @returns one entry per table, in load order.
     */
    async tables() {
        return this.#enqueue(async () => {
            this.#assertOpen();
            const result = [];
            for (const [table, source] of this.#sources) {
                result.push({ table, rows: await this.#count(table), source });
            }
            return result;
        });
    }
    /** Close the connection and the instance, letting one in-flight statement settle first. */
    async close() {
        await this.#enqueue(async () => {
            if (this.#closed)
                return;
            this.#closed = true;
            const connection = this.#connection;
            const instance = this.#instance;
            try {
                connection.interrupt();
            }
            catch {
                // A connection with nothing running may reject the interrupt; closing still applies.
            }
            connection.closeSync();
            instance.closeSync();
        });
    }
    /**
     * Run one statement with a cooperative deadline and caller cancellation.
     * @param sql - host-authored statement.
     * @param signal - caller cancellation, forwarded to a native interrupt.
     * @returns the materialized reader.
     */
    async #run(sql, signal) {
        const timeoutMs = this.#config.queryTimeoutMs;
        let timedOut = false;
        const abort = () => {
            this.#connection.interrupt();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            abort();
        }, timeoutMs);
        if (signal.aborted)
            abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
            return await this.#connection.runAndReadAll(sql);
        }
        catch (error) {
            if (signal.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
            }
            if (timedOut)
                throw queryTimedOut(timeoutMs);
            throw error;
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        }
    }
    /** Describe a table's columns. */
    async #describe(table) {
        const reader = await this.#connection.runAndReadAll(`DESCRIBE ${identifier(table)}`);
        return reader.getRowObjects().map(row => ({
            name: String(row['column_name'] ?? ''),
            type: String(row['column_type'] ?? 'UNKNOWN'),
        }));
    }
    /** Exact row count of a table. */
    async #count(table) {
        const reader = await this.#connection.runAndReadAll(`SELECT count(*) AS rows FROM ${identifier(table)}`);
        const value = reader.getRowObjectsJson()[0]?.['rows'];
        return typeof value === 'number' ? value : Number(value ?? 0);
    }
    /** First rows of a table, for the load confirmation. */
    async #sample(table, columns) {
        const limit = 5;
        const reader = await this.#connection.runAndReadAll(`SELECT * FROM ${identifier(table)} LIMIT ${limit}`);
        const rows = reader.getRowObjectsJson();
        return rows.map(row => Object.fromEntries(columns.map(column => [column.name, row[column.name] ?? null])));
    }
}
/**
 * Extract a readable message from a native engine error.
 * @param error - thrown value.
 * @returns the message without the native `Error: ` envelope.
 */
function messageOf(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/^Error:\s*/u, '').split('\n')[0] ?? text;
}
