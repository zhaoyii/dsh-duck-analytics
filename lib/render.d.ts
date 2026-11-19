/**
 * Model-facing presentation of query results.
 *
 * The rendered text is what the tool card shows in the Web client: the built-in
 * generic tool row renders tool result text verbatim, so the tables and bars
 * here are the entire first-version visual story. Nothing in this module reads
 * state, the clock, or the database.
 *
 * @module duckdb-analytics/render
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ColumnInfo, LoadResult, QueryResult, ResultRow, TableInfo } from './session-database.ts';
/**
 * Render one cell for display.
 * @param value - cell value.
 * @returns printable text.
 */
export declare function formatCell(value: JsonValue): string;
/**
 * Render a fixed-width table. Every column is left-aligned; the model reads the
 * same text the user sees.
 * @param columns - result columns in order.
 * @param rows - rows to render.
 * @param maxRows - rows kept before truncation.
 * @returns the table block, or a `(no rows)` line for an empty result.
 */
export declare function renderTable(columns: readonly ColumnInfo[], rows: readonly ResultRow[], maxRows?: number): string;
/**
 * Render a text bar chart for one label column and one numeric column.
 * @param rows - full result rows.
 * @param x - label column name.
 * @param y - numeric column name.
 * @param title - chart title.
 * @returns the chart block, or `null` when no row carries a numeric value.
 */
export declare function renderBarChart(rows: readonly ResultRow[], x: string, y: string, title: string): string | null;
/**
 * Render the `duckdb_load` confirmation.
 * @param value - load outcome.
 * @returns summary, schema, and sample rows.
 */
export declare function renderLoad(value: LoadResult): string;
/**
 * Render the `duckdb_sql` result, with an optional chart.
 * @param value - query result.
 * @param chart - requested chart, already validated against the result columns.
 * @returns the result block.
 */
export declare function renderQuery(value: QueryResult, chart: {
    x: string;
    y: string;
    title: string;
} | null): string;
/**
 * Render the `duckdb_tables` listing.
 * @param tables - loaded tables.
 * @returns the listing block.
 */
export declare function renderTables(tables: readonly TableInfo[]): string;
