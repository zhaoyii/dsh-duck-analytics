/** Discriminant stamped into the metadata so a version can be refused. */
export const CHART_META_KIND = 'dsh-duckdb-chart';
/** Metadata version; the client refuses anything else and falls back to text. */
export const CHART_META_VERSION = 1;
/** Most points a card plots; the rest are reported as an omission count. */
export const MAX_CHART_POINTS = 120;
/**
 * Coerce one result cell to a plottable number.
 * @param value - raw cell value.
 * @returns the number, or `null` when the cell is not numeric.
 */
export function toNumber(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
/**
 * Render one result cell as a chart label.
 * @param value - raw cell value.
 * @returns display text for the axis category.
 */
export function toLabel(value) {
    if (value === null)
        return 'NULL';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value) ?? '';
}
/**
 * Project result rows onto a bounded, replayable point list.
 * @param rows - result rows in display order.
 * @param x - label column name.
 * @param y - value column name.
 * @returns the plotted points and how many were dropped by the cap.
 */
export function projectPoints(rows, x, y) {
    const points = [];
    let omitted = 0;
    for (const row of rows) {
        const value = toNumber(row[y] ?? null);
        if (value === null)
            continue;
        if (points.length >= MAX_CHART_POINTS) {
            omitted += 1;
            continue;
        }
        points.push({ label: toLabel(row[x] ?? null), value });
    }
    return { points, omitted };
}
