import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatCell, renderBarChart, renderLoad, renderQuery, renderTable, renderTables,
} from '../src/render.ts'

const COLUMNS = [{ name: 'month', type: 'VARCHAR' }, { name: 'sales', type: 'BIGINT' }]
const ROWS = [
  { month: '2026-01', sales: 120 },
  { month: '2026-02', sales: 140 },
]

describe('cell formatting', () => {
  it('renders scalars, null, and nested JSON', () => {
    assert.equal(formatCell('a'), 'a')
    assert.equal(formatCell(12), '12')
    assert.equal(formatCell(true), 'true')
    assert.equal(formatCell(null), 'NULL')
    assert.equal(formatCell([1, 2]), '[1,2]')
  })
})

describe('table rendering', () => {
  it('aligns columns under their headers', () => {
    const text = renderTable(COLUMNS, ROWS)
    const [header, divider, first] = text.split('\n')
    assert.match(header ?? '', /^month\s+sales$/u)
    assert.match(divider ?? '', /^\u2500+\s+\u2500+$/u)
    assert.match(first ?? '', /^2026-01\s+120\s*$/u)
  })

  it('reports rows beyond the display cap', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ month: `m${index}`, sales: index }))
    const text = renderTable(COLUMNS, rows, 2)
    assert.match(text, /3 more row\(s\) not shown/u)
  })

  it('handles an empty result', () => {
    assert.equal(renderTable(COLUMNS, []), '(no rows)')
  })

  it('elides long cells', () => {
    const text = renderTable([{ name: 'v', type: 'VARCHAR' }], [{ v: 'x'.repeat(80) }])
    assert.match(text, /x{39}\u2026/u)
  })
})

describe('bar chart rendering', () => {
  it('scales the largest bar to full width', () => {
    const text = renderBarChart(ROWS, 'month', 'sales', 'sales by month')
    assert.ok(text !== null)
    const lines = text.split('\n')
    assert.equal(lines[0], 'sales by month')
    assert.match(lines[1] ?? '', /\u2588{21}\u2591{3}\s+120$/u)
    assert.match(lines[2] ?? '', /\u2588{24}\s+140$/u)
  })

  it('returns null when no value is numeric', () => {
    assert.equal(renderBarChart([{ month: 'a', sales: 'n/a' }], 'month', 'sales', 't'), null)
  })

  it('accepts numeric strings from bigint columns', () => {
    const text = renderBarChart([{ month: 'a', sales: '42' }], 'month', 'sales', 't')
    assert.match(text ?? '', /42$/u)
  })
})

describe('tool renders', () => {
  it('reports a load with schema and sample', () => {
    const text = renderLoad({
      table: 'sales', source: 'sales.csv', rows: 2, columns: COLUMNS, sample: ROWS,
    })
    assert.match(text, /Loaded sales\.csv as table "sales" \(2 rows\)/u)
    assert.match(text, /month VARCHAR/u)
    assert.match(text, /2026-01\s+120/u)
  })

  it('reports row count, chart, and table for a query', () => {
    const text = renderQuery({ columns: COLUMNS, rows: ROWS, truncated: false }, {
      x: 'month', y: 'sales', title: 'sales by month',
    })
    assert.match(text, /2 row\(s\)\./u)
    assert.match(text, /sales by month/u)
    assert.match(text, /2026-02\s+140/u)
  })

  it('flags a truncated result', () => {
    const text = renderQuery({ columns: COLUMNS, rows: ROWS, truncated: true }, null)
    assert.match(text, /truncated by the result cap/u)
  })

  it('lists loaded tables and says so when none are loaded', () => {
    assert.match(renderTables([{ table: 'sales', rows: 2, source: 'sales.csv' }]), /sales - 2 rows from sales\.csv/u)
    assert.match(renderTables([]), /No tables are loaded/u)
  })
})
