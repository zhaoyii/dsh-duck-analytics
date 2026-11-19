import { defineTool } from '@deepseek-ai/dsh-tools';
import { CHART_META_KIND, CHART_META_VERSION, projectPoints } from "./chart-meta.js";
import { resolveDataFile, tableNameFor } from "./data-files.js";
import { requestRejected } from "./errors.js";
import { renderLoad, renderQuery, renderTables } from "./render.js";
/** One result column, shared by every output schema. */
const COLUMN = {
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string', required: true },
        type: { type: 'string', required: true },
    },
};
/** One result row: an open object whose cells are arbitrary lossless JSON. */
const ROW = { type: 'object', additionalProperties: true };
const LOAD_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        table: { type: 'string', required: true },
        source: { type: 'string', required: true },
        rows: { type: 'number', required: true },
        columns: { type: 'array', items: COLUMN, required: true },
        sample: { type: 'array', items: ROW, required: true },
    },
};
const QUERY_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        sql: { type: 'string', required: true },
        columns: { type: 'array', items: COLUMN, required: true },
        rows: { type: 'array', items: ROW, required: true },
        rowCount: { type: 'number', required: true },
        truncated: { type: 'boolean', required: true },
    },
};
const TABLES_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        tables: {
            type: 'array',
            required: true,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    table: { type: 'string', required: true },
                    rows: { type: 'number', required: true },
                    source: { type: 'string', required: true },
                },
            },
        },
    },
};
/**
 * Resolve the calling Agent, which owns the conversation database.
 * @param agent - Agent carried by the tool execution.
 * @returns the owning Agent.
 * @throws AnalyticsError when the call has no owning Agent.
 */
function requireAgent(agent) {
    if (agent === undefined) {
        throw requestRejected('This tool needs an owning Agent and cannot run outside a conversation step.');
    }
    return agent;
}
/**
 * Check that a requested chart can be drawn from a result.
 * @param columns - result columns.
 * @param rows - result rows.
 * @param chart - requested label and value columns.
 * @returns the chart with its resolved title.
 * @throws AnalyticsError when a field is missing or holds no numeric value.
 */
export function resolveChart(columns, rows, chart) {
    const available = columns.map(column => column.name);
    const joined = available.join(', ');
    if (!available.includes(chart.x)) {
        throw requestRejected(`chart.x "${chart.x}" is not a result column. Available columns: ${joined}.`);
    }
    if (!available.includes(chart.y)) {
        throw requestRejected(`chart.y "${chart.y}" is not a result column. Available columns: ${joined}.`);
    }
    const numeric = rows.some((row) => {
        const value = row[chart.y] ?? null;
        return typeof value === 'number'
            || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
    });
    if (!numeric) {
        throw requestRejected(`chart.y "${chart.y}" holds no numeric value to chart. Aggregate the query first.`);
    }
    return { x: chart.x, y: chart.y, title: chart.title ?? `${chart.y} by ${chart.x}` };
}
/**
 * Build the analytics tool definitions.
 * @param options - registry, data root, and import limit.
 * @returns the three tool definitions, in registration order.
 */
export function createAnalyticsTools(options) {
    const { registry, root, maxFileBytes } = options;
    const load = defineTool({
        name: 'duckdb_load',
        description: 'Import a CSV, Parquet, or JSON file into this conversation\'s private DuckDB as a table. '
            + 'Call this before querying a file. "filePath" is relative to the analytics data directory fixed by the '
            + 'administrator; absolute paths and paths outside it are refused. Returns the table name, its columns and '
            + 'types, its row count, and sample rows. Loaded tables live only in this conversation.',
        parameters: {
            filePath: {
                type: 'string',
                required: true,
                description: 'File path relative to the analytics data directory, for example "sales.csv".',
            },
        },
        output: {
            schema: LOAD_OUTPUT,
            render: (_args, value) => [{ type: 'text', text: renderLoad(value) }],
        },
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const database = await registry.for(requireAgent(exec.agent));
            const file = await resolveDataFile({ root, input: args.filePath, maxBytes: maxFileBytes });
            const taken = new Set((await database.tables()).map(table => table.table));
            const result = await database.load(file, tableNameFor(file.displayName, taken), exec.signal);
            exec.signal.throwIfAborted();
            return result;
        },
    });
    const tables = defineTool({
        name: 'duckdb_tables',
        description: 'List the tables loaded in this conversation with their row counts and source files. '
            + 'Use it to recall table names before writing SQL, or to check what a follow-up question can reach.',
        parameters: {},
        output: {
            schema: TABLES_OUTPUT,
            render: (_args, value) => [{ type: 'text', text: renderTables(value.tables) }],
        },
        async execute(_args, exec) {
            exec.signal.throwIfAborted();
            const database = await registry.for(requireAgent(exec.agent));
            return { tables: await database.tables() };
        },
    });
    const query = defineTool({
        name: 'duckdb_sql',
        description: 'Run exactly one read-only SQL statement (SELECT, or WITH ... SELECT) over the tables loaded in this '
            + 'conversation. SQL cannot read files or the network: import with duckdb_load first. Results are capped and '
            + 'the query has a deadline. Set "chart" to also draw a small bar chart in the tool card.',
        parameters: {
            sql: {
                type: 'string',
                required: true,
                description: 'One SELECT or WITH ... SELECT statement over the loaded tables.',
            },
            chart: {
                type: 'object',
                additionalProperties: false,
                description: 'Optional chart drawn in the conversation from the result rows.',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['bar', 'line', 'pie'],
                        required: true,
                        description: 'Chart kind. Use "line" for a time series, "bar" to compare categories, "pie" for parts of a whole.',
                    },
                    x: { type: 'string', required: true, description: 'Result column used as the category label.' },
                    y: { type: 'string', required: true, description: 'Numeric result column used as the value.' },
                    title: { type: 'string', description: 'Chart title. Defaults to "<y> by <x>".' },
                },
            },
        },
        output: {
            schema: QUERY_OUTPUT,
            render: (args, value) => [{
                    type: 'text',
                    text: renderQuery(value, args.chart === undefined ? null : resolveChart(value.columns, value.rows, args.chart)),
                }],
            presentationMeta: (args, value) => {
                const requested = args.chart;
                const chart = requested === undefined ? null : resolveChart(value.columns, value.rows, requested);
                const plotted = chart === null ? { points: [], omitted: 0 } : projectPoints(value.rows, chart.x, chart.y);
                const meta = {
                    kind: CHART_META_KIND,
                    version: CHART_META_VERSION,
                    chart: chart === null || requested === undefined
                        ? null
                        : { type: requested.type, title: chart.title, x: chart.x, y: chart.y },
                    points: plotted.points,
                    omitted: plotted.omitted,
                    rowCount: value.rowCount,
                    truncated: value.truncated,
                };
                return meta;
            },
        },
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const database = await registry.for(requireAgent(exec.agent));
            const result = await database.query(args.sql, exec.signal);
            if (args.chart !== undefined)
                resolveChart(result.columns, result.rows, args.chart);
            exec.signal.throwIfAborted();
            return {
                sql: args.sql,
                columns: result.columns,
                rows: result.rows,
                rowCount: result.rows.length,
                truncated: result.truncated,
            };
        },
    });
    return [load, tables, query];
}
