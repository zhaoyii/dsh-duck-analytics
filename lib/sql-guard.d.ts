/**
 * Admission check for model-authored SQL.
 *
 * This module is the *text* half of the query boundary; the database layer
 * separately makes DuckDB itself prove the statement count. Neither half is a
 * full SQL sandbox: see `docs/02-设计-关系模型与抽象.md` for the threat model and
 * for what a stricter deployment must add.
 *
 * The check works on tokens, not on raw text, so keywords inside string
 * literals, quoted identifiers, and comments cannot be mistaken for syntax.
 *
 * @module duckdb-analytics/sql-guard
 */
/**
 * Inspect one model-authored SQL string.
 *
 * The returned `statement` is the text with trailing terminators, comments, and
 * whitespace removed, so it can be embedded in a synthetic wrapper query. The
 * `violations` list is empty when the statement may run.
 *
 * @param sql - raw SQL text from the model.
 * @returns the embeddable statement text plus every admission violation found.
 */
export declare function inspectSql(sql: string): {
    statement: string;
    violations: string[];
};
