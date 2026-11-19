/**
 * Resolution of model-supplied file names to one administrator-configured data
 * directory.
 *
 * The model supplies a *relative* path. This module refuses absolute paths,
 * escapes above the root (including through symbolic links), unsupported
 * formats, and oversized files before the engine ever opens the file.
 *
 * @module duckdb-analytics/data-files
 */
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { AnalyticsError, engineFailure, requestRejected } from './errors.ts'

/** File formats DuckDB reads natively, mapped to the reader that ingests them. */
export const SUPPORTED_FORMATS = new Map<string, 'csv' | 'parquet' | 'json'>([
  ['.csv', 'csv'],
  ['.parquet', 'parquet'],
  ['.json', 'json'],
])

/** One validated file that may be loaded into a session database. */
export interface DataFile {
  /** Absolute, symlink-resolved path safe to embed in a host-authored statement. */
  readonly absolutePath: string
  /** File name shown to the model and the user. */
  readonly displayName: string
  /** Detected format, which selects the DuckDB reader. */
  readonly format: 'csv' | 'parquet' | 'json'
  /** Size in bytes, already checked against the configured maximum. */
  readonly bytes: number
}

/**
 * Verify that a configured root exists and return its resolved path.
 * @param configured - root value from plugin configuration.
 * @returns the symlink-resolved absolute root.
 * @throws AnalyticsError when the directory is missing, so misconfiguration fails at load.
 */
export async function resolveDataRoot(configured: string): Promise<string> {
  const absolute = path.resolve(configured)
  let resolved: string
  try {
    resolved = await realpath(absolute)
  } catch (error) {
    throw engineFailure(
      `Analytics data directory "${absolute}" does not exist. `
      + 'Create it, or point the duckdb-analytics row\'s `dataRoot` at an existing directory '
      + '(profile cordis.patch.yml, or this bundle\'s cordis.patch.yml).',
      error,
    )
  }
  const info = await stat(resolved)
  if (!info.isDirectory()) {
    throw engineFailure(`Analytics data directory "${resolved}" is not a directory.`)
  }
  return resolved
}

/**
 * Resolve one model-supplied path inside the data root.
 * @param options - resolved root, the model's relative path, and the size limit.
 * @returns the validated file.
 * @throws AnalyticsError for absolute paths, escapes, unknown formats, or oversized files.
 */
export async function resolveDataFile(options: {
  root: string
  input: string
  maxBytes: number
}): Promise<DataFile> {
  const trimmed = options.input.trim()
  if (trimmed === '') throw requestRejected('filePath is empty.')
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw requestRejected(`"${trimmed}" is an absolute path. Pass a path relative to the configured analytics data directory.`)
  }

  const candidate = path.resolve(options.root, trimmed)
  const relative = path.relative(options.root, candidate)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw requestRejected(`"${trimmed}" resolves outside the analytics data directory.`)
  }

  let resolved: string
  let bytes: number
  try {
    // Resolve symlinks before the containment check above is trusted again.
    resolved = await realpath(candidate)
    const stillInside = path.relative(options.root, resolved)
    if (stillInside.startsWith(`..${path.sep}`) || path.isAbsolute(stillInside)) {
      throw requestRejected(`"${trimmed}" links outside the analytics data directory.`)
    }
    const info = await stat(resolved)
    if (!info.isFile()) throw requestRejected(`"${trimmed}" is not a regular file.`)
    bytes = info.size
  } catch (error) {
    if (error instanceof AnalyticsError) throw error
    throw requestRejected(`"${trimmed}" cannot be read. Check that it exists under the analytics data directory.`)
  }

  if (bytes > options.maxBytes) {
    throw requestRejected(`"${trimmed}" is ${bytes} bytes and exceeds the ${options.maxBytes}-byte import limit.`)
  }

  const format = SUPPORTED_FORMATS.get(path.extname(resolved).toLowerCase())
  if (format === undefined) {
    throw requestRejected(`"${trimmed}" is not a supported format. Supported extensions: ${[...SUPPORTED_FORMATS.keys()].join(', ')}.`)
  }

  return { absolutePath: resolved, displayName: path.basename(resolved), format, bytes }
}

/**
 * Render a table name from a file name and a collision-free suffix.
 * @param displayName - source file name.
 * @param taken - table names already present in the session database.
 * @returns a lowercase identifier matching `[a-z][a-z0-9_]*`.
 */
export function tableNameFor(displayName: string, taken: ReadonlySet<string>): string {
  const stem = path.parse(displayName).name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = /^[a-z]/.test(stem) ? stem : `t_${stem}`
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}
