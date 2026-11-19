import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { SessionRegistry } from './session-registry.ts';
import type { ColumnInfo, ResultRow } from './session-database.ts';
/** Resources the tools share. */
export interface AnalyticsToolOptions {
    /** Per-Agent database owner. */
    readonly registry: SessionRegistry;
    /** Resolved data directory that model paths resolve inside. */
    readonly root: string;
    /** Largest importable file. */
    readonly maxFileBytes: number;
}
/** A chart request as the model supplies it. */
interface ChartRequest {
    readonly x: string;
    readonly y: string;
    readonly title?: string;
}
/**
 * Check that a requested chart can be drawn from a result.
 * @param columns - result columns.
 * @param rows - result rows.
 * @param chart - requested label and value columns.
 * @returns the chart with its resolved title.
 * @throws AnalyticsError when a field is missing or holds no numeric value.
 */
export declare function resolveChart(columns: readonly ColumnInfo[], rows: readonly ResultRow[], chart: ChartRequest): {
    x: string;
    y: string;
    title: string;
};
/**
 * Build the analytics tool definitions.
 * @param options - registry, data root, and import limit.
 * @returns the three tool definitions, in registration order.
 */
export declare function createAnalyticsTools(options: AnalyticsToolOptions): ToolDefinition[];
export {};
