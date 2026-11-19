/**
 * The replayable chart payload carried by a `duckdb_sql` result.
 *
 * `output.presentationMeta` is what survives into the session log; the canonical
 * query value does not. The browser card therefore cannot re-derive a plot from
 * the result and must be handed the plotted points directly. This module is the
 * single place that decides what those points are, so the Host projection and
 * the Client reader agree without sharing a runtime import.
 *
 * The payload is deliberately flat and small: one entry per plotted point, no
 * row objects, no SQL text, no unbounded arrays.
 *
 * @module duckdb-analytics/chart-meta
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Discriminant stamped into the metadata so a version can be refused. */
export const CHART_META_KIND = 'dsh-duckdb-chart'

/** Metadata version; the client refuses anything else and falls back to text. */
export const CHART_META_VERSION = 1

/** Most points a card plots; the rest are reported as an omission count. */
export const MAX_CHART_POINTS = 120

/** Chart kinds this version can draw. */
export type ChartKind = 'bar' | 'line' | 'pie'

/** One plotted point: a label and its numeric value. */
export interface ChartPoint {
  readonly label: string
  readonly value: number
}

/** The `presentationMeta` payload of one `duckdb_sql` result. */
export interface ChartMeta {
  readonly kind: typeof CHART_META_KIND
  readonly version: typeof CHART_META_VERSION
  /** Requested chart, or `null` when the call asked for no chart. */
  readonly chart: {
    readonly type: ChartKind
    readonly title: string
    /** Result column the labels came from. */
    readonly x: string
    /** Result column the values came from. */
    readonly y: string
  } | null
  /** Plotted points, bounded to {@link MAX_CHART_POINTS}. */
  readonly points: readonly ChartPoint[]
  /** Points dropped by the cap, so the card can say the plot is partial. */
  readonly omitted: number
  /** Rows the query returned (after `maxResultRows`). */
  readonly rowCount: number
  /** Whether the result itself was truncated by `maxResultRows`. */
  readonly truncated: boolean
}

/**
 * Coerce one result cell to a plottable number.
 * @param value - raw cell value.
 * @returns the number, or `null` when the cell is not numeric.
 */
export function toNumber(value: JsonValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Render one result cell as a chart label.
 * @param value - raw cell value.
 * @returns display text for the axis category.
 */
export function toLabel(value: JsonValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

/**
 * Project result rows onto a bounded, replayable point list.
 * @param rows - result rows in display order.
 * @param x - label column name.
 * @param y - value column name.
 * @returns the plotted points and how many were dropped by the cap.
 */
export function projectPoints(
  rows: readonly Readonly<Record<string, JsonValue>>[],
  x: string,
  y: string,
): { points: ChartPoint[], omitted: number } {
  const points: ChartPoint[] = []
  let omitted = 0
  for (const row of rows) {
    const value = toNumber(row[y] ?? null)
    if (value === null) continue
    if (points.length >= MAX_CHART_POINTS) {
      omitted += 1
      continue
    }
    points.push({ label: toLabel(row[x] ?? null), value })
  }
  return { points, omitted }
}
