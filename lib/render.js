/** Longest cell text kept before elision. */
const MAX_CELL_WIDTH = 40;
/** Longest bar, in characters. */
const BAR_WIDTH = 24;
/** Rows rendered for one table. */
const MAX_TABLE_ROWS = 20;
/** Bars rendered for one chart. */
const MAX_BARS = 15;
/** Horizontal rule used between a header and its body. */
const RULE = '\u2500';
/** Full block and light shade used for bars. */
const BAR_FULL = '\u2588';
const BAR_REST = '\u2591';
/**
 * Render one cell for display.
 * @param value - cell value.
 * @returns printable text.
 */
export function formatCell(value) {
    if (value === null)
        return 'NULL';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value) ?? '';
}
/**
 * Count printed columns for one string, treating CJK and fullwidth forms as double width.
 * @param text - printable text.
 * @returns approximate terminal column count.
 */
function displayWidth(text) {
    let width = 0;
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
            || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f)
            || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
            || (code >= 0x1f300 && code <= 0x1faff)) ? 2 : 1;
    }
    return width;
}
/**
 * Elide one cell that exceeds the print budget.
 * @param text - printable cell text.
 * @returns text at most `MAX_CELL_WIDTH` characters wide.
 */
function truncate(text) {
    if (text.length <= MAX_CELL_WIDTH)
        return text;
    return `${text.slice(0, MAX_CELL_WIDTH - 1)}\u2026`;
}
/**
 * Pad text to an exact printed width.
 * @param text - printable text.
 * @param width - target printed width.
 * @returns the text followed by spaces.
 */
function pad(text, width) {
    return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}
/**
 * Render a fixed-width table. Every column is left-aligned; the model reads the
 * same text the user sees.
 * @param columns - result columns in order.
 * @param rows - rows to render.
 * @param maxRows - rows kept before truncation.
 * @returns the table block, or a `(no rows)` line for an empty result.
 */
export function renderTable(columns, rows, maxRows = MAX_TABLE_ROWS) {
    if (columns.length === 0)
        return '(no columns)';
    if (rows.length === 0)
        return '(no rows)';
    const shown = rows.slice(0, maxRows);
    const cells = shown.map(row => columns.map(column => truncate(formatCell(row[column.name] ?? null))));
    const widths = columns.map((column, index) => Math.max(displayWidth(column.name), ...cells.map(line => displayWidth(line[index] ?? ''))));
    const header = columns.map((column, index) => pad(column.name, widths[index] ?? 0)).join('  ');
    const divider = widths.map(width => RULE.repeat(width)).join('  ');
    const body = cells.map(line => line.map((cell, index) => pad(cell, widths[index] ?? 0)).join('  '));
    const omitted = rows.length > shown.length
        ? [`(${rows.length - shown.length} more row(s) not shown)`]
        : [];
    return [header, divider, ...body, ...omitted].join('\n');
}
/**
 * Render a text bar chart for one label column and one numeric column.
 * @param rows - full result rows.
 * @param x - label column name.
 * @param y - numeric column name.
 * @param title - chart title.
 * @returns the chart block, or `null` when no row carries a numeric value.
 */
export function renderBarChart(rows, x, y, title) {
    const points = [];
    for (const row of rows.slice(0, MAX_BARS)) {
        const raw = row[y] ?? null;
        const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
        if (!Number.isFinite(value))
            continue;
        points.push({ label: formatCell(row[x] ?? null), value });
    }
    if (points.length === 0)
        return null;
    const maxMagnitude = Math.max(...points.map(point => Math.abs(point.value)), 0);
    const labelWidth = Math.max(...points.map(point => displayWidth(point.label)));
    const lines = points.map((point) => {
        const filled = maxMagnitude === 0 ? 0 : Math.round((Math.abs(point.value) / maxMagnitude) * BAR_WIDTH);
        return `${pad(point.label, labelWidth)}  ${BAR_FULL.repeat(filled)}${BAR_REST.repeat(BAR_WIDTH - filled)}  ${point.value}`;
    });
    const omitted = rows.length > points.length
        ? [`(${rows.length - points.length} more row(s) not charted)`]
        : [];
    return [title, ...lines, ...omitted].join('\n');
}
/**
 * Render the `duckdb_load` confirmation.
 * @param value - load outcome.
 * @returns summary, schema, and sample rows.
 */
export function renderLoad(value) {
    const schema = value.columns.map(column => `  ${column.name} ${column.type}`).join('\n');
    return [
        `Loaded ${value.source} as table "${value.table}" (${value.rows} rows).`,
        'Columns:',
        schema,
        'Sample:',
        renderTable(value.columns, value.sample, value.sample.length),
    ].join('\n');
}
/**
 * Render the `duckdb_sql` result, with an optional chart.
 * @param value - query result.
 * @param chart - requested chart, already validated against the result columns.
 * @returns the result block.
 */
export function renderQuery(value, chart) {
    const parts = [`${value.rows.length} row(s)${value.truncated ? ' (truncated by the result cap)' : ''}.`];
    if (chart !== null) {
        const chartText = renderBarChart(value.rows, chart.x, chart.y, chart.title);
        if (chartText !== null)
            parts.push(chartText);
    }
    parts.push(renderTable(value.columns, value.rows));
    return parts.join('\n\n');
}
/**
 * Render the `duckdb_tables` listing.
 * @param tables - loaded tables.
 * @returns the listing block.
 */
export function renderTables(tables) {
    if (tables.length === 0)
        return 'No tables are loaded in this conversation yet.';
    return tables.map(table => `  ${table.table} - ${table.rows} rows from ${table.source}`).join('\n');
}
