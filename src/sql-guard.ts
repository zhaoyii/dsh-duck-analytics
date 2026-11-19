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

/** One lexical token with its position in the source text. */
interface Token {
  readonly kind: 'word' | 'quoted' | 'string' | 'number' | 'punct'
  readonly text: string
  readonly start: number
  readonly end: number
}

/** Keywords that end a table-reference list. */
const TABLE_LIST_ENDERS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'QUALIFY', 'WINDOW',
  'UNION', 'EXCEPT', 'INTERSECT', 'SELECT', 'ON', 'USING', 'RETURNING',
])

/** Leading keywords of a read-only statement. */
const READ_ONLY_STARTS = new Set(['SELECT', 'WITH'])

/**
 * Table functions that read local files or the network. The check applies only
 * in call position (`name(`), so a table or column merely *named* `read_sales`
 * stays usable.
 */
const FORBIDDEN_CALL = /^(?:read_[a-z0-9_]+|[a-z0-9_]+_scan|scan_[a-z0-9_]+|glob|sniff_[a-z0-9_]+|st_read|parquet_(?:metadata|schema|kv_metadata))$/

/**
 * Split SQL into tokens, skipping whitespace and comments.
 * @param sql - source text.
 * @returns tokens in source order.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]

    if (char === '-' && next === '-') {
      const lineEnd = sql.indexOf('\n', index)
      index = lineEnd === -1 ? sql.length : lineEnd + 1
      continue
    }
    if (/\s/u.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (char === "'" || char === '"') {
      const start = index
      index += 1
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      tokens.push({ kind: char === "'" ? 'string' : 'quoted', text: sql.slice(start, index), start, end: index })
      continue
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index))
      if (tag !== null) {
        const terminator = tag[0]
        const close = sql.indexOf(terminator, index + terminator.length)
        const end = close === -1 ? sql.length : close + terminator.length
        tokens.push({ kind: 'string', text: sql.slice(index, end), start: index, end })
        index = end
        continue
      }
    }
    if (/[0-9]/.test(char) || (char === '.' && next !== undefined && /[0-9]/.test(next))) {
      const start = index
      while (index < sql.length && /[0-9.eE]/.test(sql[index] as string)) index += 1
      tokens.push({ kind: 'number', text: sql.slice(start, index), start, end: index })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index] as string)) index += 1
      tokens.push({ kind: 'word', text: sql.slice(start, index), start, end: index })
      continue
    }
    tokens.push({ kind: 'punct', text: char, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

/**
 * State of one parenthesis depth while scanning for table references.
 * A string literal may only appear where a table reference is not expected.
 */
interface Frame {
  expectTable: boolean
  inTableList: boolean
}

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
export function inspectSql(sql: string): { statement: string, violations: string[] } {
  const tokens = tokenize(sql)
  const violations: string[] = []

  if (tokens.length === 0) {
    return { statement: '', violations: ['SQL is empty.'] }
  }

  const first = tokens[0] as Token
  if (first.kind !== 'word' || !READ_ONLY_STARTS.has(first.text.toUpperCase())) {
    violations.push('Only a single SELECT or WITH ... SELECT statement is allowed.')
  }

  // Drop trailing terminators: `SELECT 1 ;;` is one statement, and the wrapper
  // query cannot carry the terminator.
  let last = tokens.length - 1
  while (last > 0 && (tokens[last] as Token).kind === 'punct' && (tokens[last] as Token).text === ';') last -= 1
  for (let index = 0; index < last; index += 1) {
    const token = tokens[index] as Token
    if (token.kind === 'punct' && token.text === ';') {
      violations.push('Only one statement may be sent per call.')
      break
    }
  }
  const statement = sql.slice(0, (tokens[last] as Token).end).trim()

  const frames: Frame[] = [{ expectTable: false, inTableList: false }]
  for (let index = 0; index <= last; index += 1) {
    const token = tokens[index] as Token
    const frame = frames[frames.length - 1] as Frame

    if (token.kind === 'punct') {
      if (token.text === '(') {
        frames.push({ expectTable: false, inTableList: false })
      } else if (token.text === ')') {
        if (frames.length > 1) frames.pop()
      } else if (token.text === ',') {
        if (frame.inTableList) frame.expectTable = true
      }
      continue
    }

    if (token.kind === 'string') {
      if (frame.expectTable) {
        violations.push('A string literal cannot stand in for a table name; load the file with duckdb_load first.')
      }
      continue
    }

    const upper = token.text.toUpperCase()
    const isTableListStart = token.kind === 'word' && (upper === 'FROM' || upper === 'JOIN')
    if (isTableListStart) {
      frame.expectTable = true
      frame.inTableList = true
    } else if (token.kind === 'word' && TABLE_LIST_ENDERS.has(upper)) {
      frame.expectTable = false
      frame.inTableList = false
    } else if (frame.expectTable) {
      frame.expectTable = false
    }

    if (token.kind === 'word') {
      const nextToken = tokens[index + 1]
      const isCall = nextToken !== undefined && nextToken.kind === 'punct' && nextToken.text === '('
      if (isCall && FORBIDDEN_CALL.test(token.text.toLowerCase())) {
        violations.push(`Function "${token.text}" reads files or the network and is not available here.`)
      }
    }
  }

  return { statement, violations }
}
