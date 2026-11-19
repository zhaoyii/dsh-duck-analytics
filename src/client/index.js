/**
 * Browser half of the DuckDB analytics plugin.
 *
 * This file is the authored source of the built `lib/client.js`. It is written
 * as a bundle *body*: the module system materializes a plugin as
 * `factory(require)`, so `require` here is the page's module-table resolver
 * (React comes from the shell-seeded baseline) and relative requires do not
 * exist. `scripts/build-client.mjs` concatenates this body with the vendored
 * ECharts build, which arrives as the `__echarts` binding below, into the
 * `window.__ModuleLoader__.load({ id, factory })` envelope the page boots.
 *
 * Everything the card draws comes from the `presentationMeta` payload the Host
 * recorded beside the tool result, so a reloaded session redraws the same chart
 * without re-running SQL. A missing, foreign, or malformed payload falls back to
 * the recorded result text: a card must never fail to render.
 *
 * @module dsh-scratch-duckdb-analytics/client
 */
const React = require('react')
const echarts = __echarts

/** Chart kinds the Host may request. */
const CHART_KINDS = ['bar', 'line', 'pie']

/** Metadata discriminant; another value means another plugin's payload. */
const META_KIND = 'dsh-duckdb-chart'

/** Metadata version this reader understands. */
const META_VERSION = 1

/**
 * Narrow one wire value to a plain object.
 * @param value - candidate value.
 * @returns whether the value is a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the chart payload out of a tool result's recorded metadata.
 * @param meta - `block.meta` of a settled tool call, however malformed.
 * @returns the chart payload, or null when this card cannot draw it.
 */
function readChartMeta(meta) {
  if (!isRecord(meta)) return null
  if (meta.kind !== META_KIND || meta.version !== META_VERSION) return null
  const chart = meta.chart
  if (!isRecord(chart)) return null
  if (!CHART_KINDS.includes(chart.type)) return null
  if (typeof chart.title !== 'string' || typeof chart.x !== 'string' || typeof chart.y !== 'string') return null
  if (!Array.isArray(meta.points)) return null
  const points = []
  for (const point of meta.points) {
    if (!isRecord(point)) return null
    if (typeof point.label !== 'string') return null
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) return null
    points.push({ label: point.label, value: point.value })
  }
  if (points.length === 0) return null
  return {
    type: chart.type,
    title: chart.title,
    x: chart.x,
    y: chart.y,
    points,
    omitted: typeof meta.omitted === 'number' && Number.isFinite(meta.omitted) ? meta.omitted : 0,
    rowCount: typeof meta.rowCount === 'number' && Number.isFinite(meta.rowCount) ? meta.rowCount : points.length,
    truncated: meta.truncated === true,
  }
}

/**
 * Join the recorded result text of a settled call.
 * @param block - settled tool-call block.
 * @returns the model-facing text the card falls back to.
 */
function resultText(block) {
  const content = block.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

/**
 * Resolve the theme-aware palette from the page's CSS custom properties.
 * @param element - mounted card element used to read computed styles.
 * @returns colors applied to the chart.
 */
function palette(element) {
  const styles = getComputedStyle(element)
  const read = (name, fallback) => {
    const value = styles.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    text: read('--dsw-alias-label-primary', '#1f2328'),
    muted: read('--dsw-alias-label-secondary', '#6b7280'),
    grid: read('--dsw-alias-border-secondary', '#e5e7eb'),
    series: [
      read('--dsw-alias-brand-primary', '#2563eb'),
      read('--dsw-alias-warning-primary', '#f59e0b'),
      read('--dsw-alias-success-primary', '#10b981'),
      read('--dsw-alias-danger-primary', '#ef4444'),
    ],
  }
}

/** Series points below this count fit one screen, so the zoom slider stays hidden. */
const ZOOM_SLIDER_MIN_POINTS = 13

/**
 * Format a value for a tooltip: integers stay integral, decimals keep 2 places.
 * @param value - numeric value.
 * @returns compact display text.
 */
function formatValue(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/**
 * Build the toolbox feature set shared by both chart families.
 *
 * `dataView` renders the plotted series as a read-only table, which is the
 * card's table view without a second UI implementation; `restore` undoes the
 * user's zoom or legend state; `saveAsImage` exports the live canvas.
 * @param meta - validated chart payload.
 * @returns the toolbox option.
 */
function buildToolbox(meta) {
  const zoomable = meta.type !== 'pie' && meta.points.length >= ZOOM_SLIDER_MIN_POINTS
  return {
    right: 2,
    top: 0,
    itemSize: 12,
    itemGap: 10,
    iconStyle: { borderWidth: 0, opacity: 0.65 },
    emphasis: { iconStyle: { opacity: 1 } },
    feature: {
      dataView: {
        readOnly: true,
        title: 'Data',
        lang: ['Data', 'Close', 'Refresh'],
      },
      restore: { title: 'Reset' },
      saveAsImage: { title: 'Save', pixelRatio: 2, backgroundColor: '#ffffff' },
      ...(zoomable ? { dataZoom: { title: { zoom: 'Zoom', back: 'Undo zoom' } } } : {}),
    },
  }
}

/**
 * Build the interactive zoom controls for a cartesian chart.
 * @param pointCount - number of plotted points.
 * @returns the `dataZoom` option array.
 */
function buildDataZoom(pointCount) {
  const inside = { type: 'inside', zoomOnMouseWheel: true, moveOnMouseMove: true, throttle: 40 }
  if (pointCount < ZOOM_SLIDER_MIN_POINTS) return [inside]
  return [inside, {
    type: 'slider',
    height: 16,
    bottom: 4,
    borderColor: 'transparent',
    fillerColor: 'rgba(37, 99, 235, 0.10)',
    handleSize: '90%',
    showDetail: false,
    brushSelect: false,
    // Show the newest window by default: a long series is most useful at its end.
    start: Math.max(0, 100 - (ZOOM_SLIDER_MIN_POINTS / pointCount) * 100),
    end: 100,
  }]
}

/**
 * Build the ECharts option for one chart payload.
 *
 * The result is a live, interactive chart: hovering reads values through an axis
 * pointer, the wheel or the slider zooms a long series, the toolbox can reset
 * that zoom, export the canvas, or show the plotted rows as a table, and pie
 * slices toggle on click.
 * @param meta - validated chart payload.
 * @param colors - resolved palette.
 * @returns an ECharts option object.
 */
function buildOption(meta, colors) {
  const labels = meta.points.map(point => point.label)
  const values = meta.points.map(point => point.value)
  const base = {
    animationDuration: 300,
    animationDurationUpdate: 240,
    textStyle: { color: colors.text, fontFamily: 'inherit' },
    title: {
      text: meta.title,
      left: 2,
      top: 2,
      textStyle: { color: colors.text, fontSize: 12, fontWeight: 600 },
    },
    toolbox: buildToolbox(meta),
  }

  if (meta.type === 'pie') {
    return {
      ...base,
      tooltip: {
        trigger: 'item',
        confine: true,
        valueFormatter: formatValue,
      },
      series: [{
        type: 'pie',
        radius: ['36%', '64%'],
        center: ['50%', '56%'],
        avoidLabelOverlap: true,
        selectedMode: 'multiple',
        selectedOffset: 8,
        itemStyle: { borderWidth: 1, borderColor: colors.grid },
        label: { color: colors.muted, fontSize: 11 },
        emphasis: { scale: true, scaleSize: 6 },
        data: meta.points.map((point, index) => ({
          name: point.label,
          value: point.value,
          itemStyle: { color: colors.series[index % colors.series.length] },
        })),
      }],
    }
  }

  const zoomed = meta.points.length >= ZOOM_SLIDER_MIN_POINTS

  return {
    ...base,
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'cross', label: { backgroundColor: colors.muted } },
      valueFormatter: formatValue,
    },
    // The slider owns the bottom strip, so the plot keeps room for its labels.
    grid: { left: 4, right: 12, top: 44, bottom: zoomed ? 34 : 4, containLabel: true },
    dataZoom: buildDataZoom(meta.points.length),
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: colors.grid } },
      axisTick: { show: false },
      axisLabel: { color: colors.muted, fontSize: 11, hideOverlap: true },
      axisPointer: { label: { color: '#ffffff' } },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
      axisLabel: { color: colors.muted, fontSize: 11 },
    },
    series: [{
      type: meta.type,
      data: values,
      smooth: meta.type === 'line',
      symbolSize: 5,
      showSymbol: meta.points.length <= 60,
      itemStyle: { color: colors.series[0] },
      lineStyle: meta.type === 'line' ? { width: 2, color: colors.series[0] } : undefined,
      areaStyle: meta.type === 'line' ? { opacity: 0.08, color: colors.series[0] } : undefined,
      barMaxWidth: 36,
      emphasis: { focus: 'series' },
      cursor: 'pointer',
    }],
  }
}

/** Card chrome shared by every state, matching the surrounding transcript. */
const CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  minWidth: 0,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-secondary, #e5e7eb)',
  borderRadius: '10px',
  background: 'var(--dsw-alias-bg-primary, #ffffff)',
}

/** One-line muted caption. */
const CAPTION_STYLE = {
  fontSize: '11px',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
}

/** Card heading. */
const HEADING_STYLE = { fontSize: '12px', fontWeight: 600 }

/** Preformatted fallback text. */
const TEXT_STYLE = {
  margin: 0,
  fontFamily: 'inherit',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'var(--dsw-alias-label-primary, #1f2328)',
}

/**
 * Mount one ECharts instance and keep it sized with its container.
 * @param props - validated chart payload.
 * @returns the chart element.
 */
function Chart(props) {
  const hostRef = React.useRef(null)
  const [broken, setBroken] = React.useState(false)

  React.useEffect(() => {
    const element = hostRef.current
    if (element === null) return undefined
    let instance
    try {
      instance = echarts.init(element, null, { renderer: 'canvas' })
      instance.setOption(buildOption(props.meta, palette(element)), true)
    } catch {
      setBroken(true)
      return undefined
    }
    const resize = () => {
      try {
        instance.resize()
      } catch {
        // A disposed instance refuses to resize; the observer dies with it.
      }
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    if (observer !== null) observer.observe(element)
    return () => {
      if (observer !== null) observer.disconnect()
      try {
        instance.dispose()
      } catch {
        // Double dispose is harmless and must not break unmount.
      }
    }
  }, [props.meta])

  if (broken) return null
  return React.createElement('div', {
    ref: hostRef,
    'data-testid': 'duckdb-chart',
    style: { width: '100%', height: '240px' },
  })
}

/**
 * One `duckdb_sql` call in the transcript.
 * @param props - tool-call owner props delivered by the slot.
 * @returns the card element.
 */
function DuckDbSqlRow(props) {
  const { phase, block } = props

  if (phase !== 'result') {
    return React.createElement('div', { style: CARD_STYLE },
      React.createElement('strong', { style: HEADING_STYLE }, 'DuckDB query'),
      React.createElement('span', { style: CAPTION_STYLE }, phase === 'preparing' ? 'Preparing…' : 'Running…'))
  }

  if (block.isError === true) {
    return React.createElement('div', { style: CARD_STYLE },
      React.createElement('strong', { style: HEADING_STYLE }, 'Query failed'),
      React.createElement('pre', { style: TEXT_STYLE }, resultText(block)))
  }

  const meta = readChartMeta(block.meta)

  if (meta === null) {
    return React.createElement('div', { style: CARD_STYLE },
      React.createElement('strong', { style: HEADING_STYLE }, 'DuckDB query'),
      React.createElement('pre', { style: TEXT_STYLE }, resultText(block)))
  }

  const caption = [
    `${meta.rowCount} row${meta.rowCount === 1 ? '' : 's'}`,
    meta.truncated ? 'truncated' : '',
    meta.omitted > 0 ? `${meta.omitted} point${meta.omitted === 1 ? '' : 's'} not plotted` : '',
  ].filter(Boolean).join(' · ')

  return React.createElement('div', { style: CARD_STYLE },
    React.createElement(Chart, { meta }),
    React.createElement('span', { style: CAPTION_STYLE }, caption))
}

/** Chart node kind registered as a first-class conversation row. */
const CHART_NODE_KIND = 'duckdb-chart'

/**
 * Read the chart payload carried by one conversation node's data.
 * @param node - conversation node produced by the chart definition.
 * @returns the chart payload, or null.
 */
function chartFromNode(node) {
  if (!isRecord(node) || !isRecord(node.data)) return null
  return readChartMeta(node.data.meta)
}

/**
 * Render one chart row in the transcript.
 *
 * A conversation node at `turn` depth, so it belongs to the message flow and is
 * not part of the foldable process group that holds tool results.
 * @param props - chat-node view props carrying the node payload.
 * @returns the chart card, or null when the payload is unreadable.
 */
function DuckDbChartNode(props) {
  const meta = chartFromNode(props.node)
  if (meta === null) return null

  const caption = [
    `${meta.rowCount} row${meta.rowCount === 1 ? '' : 's'}`,
    meta.truncated ? 'truncated' : '',
    meta.omitted > 0 ? `${meta.omitted} point${meta.omitted === 1 ? '' : 's'} not plotted` : '',
  ].filter(Boolean).join(' · ')

  return React.createElement('div', { style: CARD_STYLE, 'data-testid': 'duckdb-chart-node' },
    React.createElement(Chart, { meta }),
    React.createElement('span', { style: CAPTION_STYLE }, caption))
}

/**
 * Conversation node definition for chart results.
 *
 * One node per Turn, carrying only the latest chart that Turn drew, derived from
 * the logged `tool/result` metadata so replay rebuilds it without re-running SQL.
 * @returns the definition accepted by `uiConversation.events.register`.
 */
function chartNodeDefinition() {
  /** Identity shared by every chart result of one Turn. */
  const idOf = event => `turn-${event.data.turn}`

  return {
    kind: CHART_NODE_KIND,
    target: 'chat',
    match: (event) => {
      if (event.type !== 'tool/result') return null
      if (readChartMeta(event.data.meta) === null) return null
      // The earliest match starts the node; later ones arrive as `start` too and
      // the engine routes them through `update`.
      return { id: idOf(event), role: 'start' }
    },
    start: (_context, match) => ({
      turn: match.event.data.turn,
      seq: match.event.seq,
      meta: match.event.data.meta,
    }),
    update: (context, match) => ({
      ...context.state,
      seq: match.event.seq,
      meta: match.event.data.meta,
    }),
    buildViewNode: (context) => {
      const state = context.state
      if (state === undefined) return null
      const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
      return {
        key: context.key,
        kind: CHART_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: state.seq,
        location,
        visibility: 'visible',
        // `turn` depth keeps the row in the transcript instead of the fold.
        groupTree: 'turn',
        data: { turn: state.turn, meta: state.meta },
      }
    },
  }
}

exports.name = 'duckdb-analytics-client'
exports.inject = ['slots', 'uiConversation']
exports.readChartMeta = readChartMeta
exports.buildOption = buildOption
exports.chartNodeDefinition = chartNodeDefinition

/**
 * Register the live tool card and the transcript chart row.
 * @param ctx - client root context carrying the slot and conversation registries.
 * @returns nothing.
 */
exports.apply = function apply(ctx) {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'duckdb_sql' },
    DuckDbSqlRow,
  ))
  ctx.uiConversation.events.register(chartNodeDefinition())
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: CHART_NODE_KIND },
    DuckDbChartNode,
  ))
}
