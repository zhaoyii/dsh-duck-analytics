import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { DataFile } from './data-files.ts';
/** Deployment-varying limits of one session database. */
export interface SessionDatabaseConfig {
    /** DuckDB `max_memory` value, for example `512MB`. */
    readonly maxMemory: string;
    /** DuckDB worker thread count for one session database. */
    readonly threads: number;
    /** Lock DuckDB configuration so no statement can change it at run time. */
    readonly lockConfiguration: boolean;
    /** Cooperative budget for one query. */
    readonly queryTimeoutMs: number;
    /** Maximum rows returned to the model per query. */
    readonly maxResultRows: number;
}
/** One result column. */
export interface ColumnInfo {
    readonly name: string;
    readonly type: string;
}
/** One result row, keyed by column name. */
export type ResultRow = Record<string, JsonValue>;
/** A bounded query result. */
export interface QueryResult {
    readonly columns: ColumnInfo[];
    readonly rows: ResultRow[];
    /** True when the query produced more rows than the configured cap. */
    readonly truncated: boolean;
}
/** A loaded table as the session reports it. */
export interface TableInfo {
    readonly table: string;
    readonly rows: number;
    /** File name the table was imported from. */
    readonly source: string;
}
/** Outcome of importing a file into the session database. */
export interface LoadResult extends TableInfo {
    readonly columns: ColumnInfo[];
    readonly sample: ResultRow[];
}
/** One live session database. */
export declare class SessionDatabase {
    #private;
    private constructor();
    /**
     * Create the database and apply its resource limits.
     * @param config - deployment limits.
     * @returns the open database.
     */
    static open(config: SessionDatabaseConfig): Promise<SessionDatabase>;
    /**
     * Import a validated file as a new table.
     * @param file - resolved file.
     * @param table - collision-free table name.
     * @param signal - caller cancellation.
     * @returns the table, its columns, its row count, and a sample.
     */
    load(file: DataFile, table: string, signal: AbortSignal): Promise<LoadResult>;
    /**
     * Run one admitted read-only query.
     * @param sql - model-authored SQL.
     * @param signal - caller cancellation.
     * @returns the bounded result.
     */
    query(sql: string, signal: AbortSignal): Promise<QueryResult>;
    /**
     * List the tables currently loaded in this conversation.
     * @returns one entry per table, in load order.
     */
    tables(): Promise<TableInfo[]>;
    /** Close the connection and the instance, letting one in-flight statement settle first. */
    close(): Promise<void>;
}
