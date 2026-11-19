/** File formats DuckDB reads natively, mapped to the reader that ingests them. */
export declare const SUPPORTED_FORMATS: Map<string, "csv" | "parquet" | "json">;
/** One validated file that may be loaded into a session database. */
export interface DataFile {
    /** Absolute, symlink-resolved path safe to embed in a host-authored statement. */
    readonly absolutePath: string;
    /** File name shown to the model and the user. */
    readonly displayName: string;
    /** Detected format, which selects the DuckDB reader. */
    readonly format: 'csv' | 'parquet' | 'json';
    /** Size in bytes, already checked against the configured maximum. */
    readonly bytes: number;
}
/**
 * Verify that a configured root exists and return its resolved path.
 * @param configured - root value from plugin configuration.
 * @returns the symlink-resolved absolute root.
 * @throws AnalyticsError when the directory is missing, so misconfiguration fails at load.
 */
export declare function resolveDataRoot(configured: string): Promise<string>;
/**
 * Resolve one model-supplied path inside the data root.
 * @param options - resolved root, the model's relative path, and the size limit.
 * @returns the validated file.
 * @throws AnalyticsError for absolute paths, escapes, unknown formats, or oversized files.
 */
export declare function resolveDataFile(options: {
    root: string;
    input: string;
    maxBytes: number;
}): Promise<DataFile>;
/**
 * Render a table name from a file name and a collision-free suffix.
 * @param displayName - source file name.
 * @param taken - table names already present in the session database.
 * @returns a lowercase identifier matching `[a-z][a-z0-9_]*`.
 */
export declare function tableNameFor(displayName: string, taken: ReadonlySet<string>): string;
