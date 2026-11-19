import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { CHART_META_KIND, CHART_META_VERSION, MAX_CHART_POINTS, projectPoints, toLabel, toNumber } from '../src/chart-meta.ts'

const workdir = path.resolve(import.meta.dirname, '..')

/** Stub React element shape: the bundle only builds trees, it never renders them. */
interface StubElement {
  readonly type: unknown
  readonly props: unknown
  readonly children: unknown[]
}

/** One registration the bundle submitted to the module loader. */
interface BundleRegistration {
  id: string
  factory: (require: (id: string) => unknown) => BundleExports
}

/**
 * Minimal React stand-in: enough for module evaluation and option building.
 * @returns the stub React object.
 */
function stubReact() {
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]): StubElement => ({ type, props, children }),
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, () => {}],
    useEffect: () => {},
  }
}

/**
 * Load the built bundle against stub page globals.
 * @returns the registered module id, its exports, and the captured slot registration.
 */
async function loadBundle() {
  const source = await readFile(path.join(workdir, 'lib/client.js'), 'utf8')
  let registration: BundleRegistration | undefined
  const page = { __ModuleLoader__: { load: (value: BundleRegistration) => { registration = value } } }
  const requireStub = (id: string): unknown => {
    if (id === 'react') return stubReact()
    throw new Error(`bundle required an unexpected module: ${id}`)
  }
  // The bundle is an expression over `window` and `require`, exactly as the page evaluates it.
  new Function('window', 'require', source)(page, requireStub)
  assert.ok(registration !== undefined, 'bundle must register with the module loader')
  const exports = registration.factory(requireStub)
  return { id: registration.id, exports }
}

/** One slot registration the bundle submitted. */
interface StubRegistration {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/** Bundle exports this suite drives. */
type BundleExports = Record<string, any>

/**
 * Run the client half's `apply` against stub registries.
 * @param exports - bundle exports.
 * @returns the slot registrations and conversation definitions the plugin made.
 */
function applyAgainstStub(exports: BundleExports) {
  const registrations: StubRegistration[] = []
  const definitions: Record<string, any>[] = []
  const ctx = {
    uiConversation: { events: { register: (definition: Record<string, any>) => definitions.push(definition) } },
    slots: {
      inject(_name: string, run: () => void) {
        run()
      },
      register(options: Record<string, unknown>, component: unknown) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { registrations, definitions }
}

describe('chart metadata helpers', () => {
  it('coerces numeric cells and rejects the rest', () => {
    assert.equal(toNumber(12), 12)
    assert.equal(toNumber('12.5'), 12.5)
    assert.equal(toNumber('n/a'), null)
    assert.equal(toNumber(null), null)
    assert.equal(toNumber(Number.NaN), null)
  })

  it('renders labels for every JSON scalar', () => {
    assert.equal(toLabel('a'), 'a')
    assert.equal(toLabel(null), 'NULL')
    assert.equal(toLabel(3), '3')
    assert.equal(toLabel({ a: 1 }), '{"a":1}')
  })

  it('projects rows onto points and reports dropped ones', () => {
    const rows = [{ m: 'a', v: '1' }, { m: 'b', v: 'x' }, { m: 'c', v: 3 }]
    assert.deepEqual(projectPoints(rows, 'm', 'v'), {
      points: [{ label: 'a', value: 1 }, { label: 'c', value: 3 }],
      omitted: 0,
    })
  })

  it('caps the point list and counts what it dropped', () => {
    const rows = Array.from({ length: MAX_CHART_POINTS + 5 }, (_, index) => ({ m: `r${index}`, v: index }))
    const { points, omitted } = projectPoints(rows, 'm', 'v')
    assert.equal(points.length, MAX_CHART_POINTS)
    assert.equal(omitted, 5)
  })
})

describe('client bundle', () => {
  it('registers under the package name the host resolved', async () => {
    const manifest = JSON.parse(await readFile(path.join(workdir, 'package.json'), 'utf8'))
    const { id } = await loadBundle()
    assert.equal(id, manifest.name)
    assert.equal(manifest.exports['./client'], './lib/client.js')
    assert.equal(manifest.dsh.client.platform, 'web')
  })

  it('exports a Cordis plugin that claims the toolview and registers a transcript node', async () => {
    const { exports } = await loadBundle()
    assert.equal(exports.name, 'duckdb-analytics-client')
    assert.deepEqual(exports.inject, ['slots', 'uiConversation'])
    const { registrations, definitions } = applyAgainstStub(exports)

    const toolview = registrations.find(entry => entry.options.name === 'tool.call.toolview')
    assert.deepEqual(toolview?.options, { name: 'tool.call.toolview', key: 'duckdb_sql' })
    assert.equal(typeof toolview?.component, 'function')

    const node = registrations.find(entry => entry.options.name === 'conversation.chat.node')
    assert.deepEqual(node?.options, { name: 'conversation.chat.node', key: 'duckdb-chart' })
    assert.equal(typeof node?.component, 'function')

    assert.equal(definitions.length, 1)
    assert.equal(definitions[0]?.kind, 'duckdb-chart')
    assert.equal(definitions[0]?.target, 'chat')
  })

  it('matches only chart-bearing tool results', async () => {
    const { exports } = await loadBundle()
    const definition = exports.chartNodeDefinition()
    const meta = {
      kind: 'dsh-duckdb-chart',
      version: 1,
      chart: { type: 'bar', title: 't', x: 'm', y: 'v' },
      points: [{ label: 'a', value: 1 }],
      omitted: 0,
      rowCount: 1,
      truncated: false,
    }

    assert.deepEqual(definition.match({ type: 'tool/result', data: { turn: 2, meta } }), {
      id: 'turn-2',
      role: 'start',
    })
    assert.equal(definition.match({ type: 'tool/result', data: { turn: 2, meta: { kind: 'other' } } }), null)
    assert.equal(definition.match({ type: 'tool/result', data: { turn: 2 } }), null)
    assert.equal(definition.match({ type: 'tool/call', data: { turn: 2 } }), null)
    // A text-only query records chart: null, which must not create an empty row.
    assert.equal(definition.match({
      type: 'tool/result',
      data: { turn: 2, meta: { ...meta, chart: null, points: [] } },
    }), null)
  })

  it('keeps one node per Turn carrying the latest chart', async () => {
    const { exports } = await loadBundle()
    const definition = exports.chartNodeDefinition()
    const first = { kind: 'dsh-duckdb-chart', version: 1, chart: null, points: [{ label: 'a', value: 1 }], omitted: 0, rowCount: 1, truncated: false }
    const second = { ...first, points: [{ label: 'b', value: 2 }] }

    const started = definition.start({}, { event: { data: { turn: 5, meta: first }, seq: 10 } })
    assert.deepEqual(started, { turn: 5, seq: 10, meta: first })
    const updated = definition.update(
      { state: started },
      { event: { data: { turn: 5, meta: second }, seq: 12 } },
    )
    assert.equal(updated.seq, 12)
    assert.deepEqual(updated.meta.points, [{ label: 'b', value: 2 }])
  })

  it('publishes the node at turn depth so the process fold cannot hide it', async () => {
    const { exports } = await loadBundle()
    const definition = exports.chartNodeDefinition()
    const meta = { kind: 'dsh-duckdb-chart', version: 1, chart: null, points: [], omitted: 0, rowCount: 0, truncated: false }
    const node = definition.buildViewNode({
      key: 'ctx-key',
      id: 'turn-3',
      start: { location: { kind: 'turn', turn: { turn: 3, status: 'closed', steps: [] } } },
      matches: [],
      state: { turn: 3, seq: 9, meta },
    })
    assert.equal(node.kind, 'duckdb-chart')
    assert.equal(node.target, 'chat')
    assert.equal(node.groupTree, 'turn', 'turn depth is what keeps the row out of the foldable process group')
    assert.equal(node.anchorSeq, 9)
    assert.deepEqual(node.data, { turn: 3, meta })
    assert.equal(definition.buildViewNode({ key: 'k', id: 'i', matches: [], state: undefined }), null)
  })

  it('inlines ECharts rather than requiring it from the page', async () => {
    const { exports } = await loadBundle()
    const option = exports.buildOption(
      { type: 'line', title: 't', points: [{ label: 'a', value: 1 }] },
      { text: '#000', muted: '#666', grid: '#eee', series: ['#2563eb', '#f59e0b'] },
    )
    assert.equal(option.series[0].type, 'line')
    assert.deepEqual(option.xAxis.data, ['a'])
    assert.deepEqual(option.series[0].data, [1])
  })
})

describe('chart interactivity', () => {
  const COLORS = { text: '#000', muted: '#666', grid: '#eee', series: ['#2563eb', '#f59e0b'] }
  const many = Array.from({ length: 40 }, (_, index) => ({ label: `m${index}`, value: index }))
  const few = [{ label: 'a', value: 1 }, { label: 'b', value: 2 }]

  /**
   * Build one option through the bundle.
   * @param type - chart kind.
   * @param points - plotted points.
   * @returns the ECharts option.
   */
  async function option(type: string, points: { label: string, value: number }[]) {
    const { exports } = await loadBundle()
    return exports.buildOption({ type, title: 't', points }, COLORS)
  }

  it('zooms a long series with both wheel and slider', async () => {
    const built = await option('line', many)
    assert.deepEqual(built.dataZoom.map((zoom: { type: string }) => zoom.type), ['inside', 'slider'])
  })

  it('keeps the slider out of the way for a short series', async () => {
    const built = await option('bar', few)
    assert.deepEqual(built.dataZoom.map((zoom: { type: string }) => zoom.type), ['inside'])
    assert.equal(built.grid.bottom, 4)
  })

  it('offers reset, export, and a data table in the toolbox', async () => {
    const built = await option('bar', few)
    assert.deepEqual(Object.keys(built.toolbox.feature).sort(), ['dataView', 'restore', 'saveAsImage'])
    assert.equal(built.toolbox.feature.dataView.readOnly, true)
  })

  it('adds the zoom toolbox button only where zoom exists', async () => {
    const bar = await option('bar', many)
    assert.ok('dataZoom' in bar.toolbox.feature)
    const pie = await option('pie', few)
    assert.ok(!('dataZoom' in pie.toolbox.feature))
  })

  it('reads values through a cross axis pointer on hover', async () => {
    const built = await option('line', few)
    assert.equal(built.tooltip.trigger, 'axis')
    assert.equal(built.tooltip.axisPointer.type, 'cross')
    assert.equal(typeof built.tooltip.valueFormatter, 'function')
    assert.equal(built.tooltip.valueFormatter(12), '12')
    assert.equal(built.tooltip.valueFormatter(12.345), '12.35')
  })

  it('lets a pie toggle slices by click', async () => {
    const built = await option('pie', few)
    assert.equal(built.series[0].selectedMode, 'multiple')
    assert.equal(built.tooltip.trigger, 'item')
    assert.equal(built.series[0].emphasis.scale, true)
  })
})

describe('client metadata reader', () => {
  /**
   * Read one payload through the built bundle.
   * @param meta - candidate metadata.
   * @returns the validated payload, or null.
   */
  async function read(meta: unknown) {
    const { exports } = await loadBundle()
    return exports.readChartMeta(meta)
  }

  const VALID = {
    kind: CHART_META_KIND,
    version: CHART_META_VERSION,
    chart: { type: 'bar', title: 'sales', x: 'month', y: 'sales' },
    points: [{ label: '2026-01', value: 120 }],
    omitted: 0,
    rowCount: 1,
    truncated: false,
  }

  it('accepts a payload the host writes', async () => {
    const meta = await read(VALID)
    assert.deepEqual(meta, {
      type: 'bar', title: 'sales', x: 'month', y: 'sales',
      points: [{ label: '2026-01', value: 120 }], omitted: 0, rowCount: 1, truncated: false,
    })
  })

  it('refuses another plugin kind or an unknown version', async () => {
    assert.equal(await read({ ...VALID, kind: 'other' }), null)
    assert.equal(await read({ ...VALID, version: 2 }), null)
  })

  it('refuses malformed payloads instead of throwing', async () => {
    assert.equal(await read(null), null)
    assert.equal(await read({ ...VALID, points: 'nope' }), null)
    assert.equal(await read({ ...VALID, points: [] }), null)
    assert.equal(await read({ ...VALID, points: [{ label: 'a', value: 'b' }] }), null)
    assert.equal(await read({ ...VALID, chart: { ...VALID.chart, type: 'radar' } }), null)
    assert.equal(await read({ ...VALID, chart: null }), null)
  })
})
