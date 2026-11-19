# 04 图表卡片：ECharts 如何进入对话流

第一版把图表画在工具结果文本里（文本条形图）。这一版把它换成真正的 ECharts 图表，直接嵌在对话流的 `duckdb_sql` 卡片内。本文说明它凭什么能工作、契约是什么、以及哪些边界是刻意保留的。

## 为什么现在能做（第一版判断的修正）

第一版文档说「scratch 插件无法交付浏览器卡片」，理由是缺少构建产物。这条判断在**机制**上是对的（必须存在 `lib/client.js`），但对**可行性**的判断过于保守：客户端 bundle 的格式是朴素的 `factory(require)`，可以离线生成，不需要接入仓库的 tsdown 流水线。

真正的三个前置条件是：

1. `package.json` 声明 `dsh.client.platform = 'web'` 且 `exports["./client"]` 指向真实文件；
2. 该文件符合模块注册协议（`window.__ModuleLoader__.load({ id, factory })`）；
3. `id` 等于 Host 解析出的包名。

第 3 条的包名来自 Host 的解析规则，而不是我在 bundle 里随便写的。规则在 `packages/client/modules/src/index.ts`：

- `locatePkgJson()`：Loader 条目的 `name` 若是路径（以 `.`、`file:` 或绝对路径开头），走 `pathToFileURL` 再 `nearestPackage()`，即**从模块文件所在目录逐级向上找最近的 `package.json`**（第 931–992 行）；
- `resolveMeta()`：读该 manifest 的 `dsh.client`，要求 `platform === 'web'`，再用 `clientExportOf()` 取 `exports["./client"]`，拼成 `clientPath`（第 891–918 行）。

因此只要 `dsh-duck-analytics/package.json` 里写着 `name: "dsh-duck-analytics"`，Host 就会把 `src/index.ts` 这一条 Loader 条目识别成**同一个包的浏览器半**，并去服务 `lib/client.js`。一个条目同时提供两半，与仓库内每个包的行为一致。

这条解析链不是靠阅读推断的：`test/client-row.test.ts` 直接 `import` 仓库构建产物 `packages/client/modules/lib/index.js`，用 `Object.create(ClientModuleRegistry.prototype)` 组装一个只带最小依赖的实例，**调用 Host 自己的 `resolveMeta`**，断言返回的 `packageName` / `clientPath` / `manifestPath`。Host 升级若改了这套规则，这个测试会立刻失败。

## 数据从哪来：`presentationMeta`

规律很硬：canonical value 不进会话日志（`ToolExecutionSuccess.value` 的注释是 "deliberately omitted from durable events"），所以刷新页面后卡片**无法**从结果里重新算出图。图必须随结果一起持久化。

Host 侧因此给 `duckdb_sql` 增加 `output.presentationMeta`，产出 `src/chart-meta.ts` 里的 `ChartMeta`：

```ts
{
  kind: 'dsh-duckdb-chart', version: 1,
  chart: { type: 'bar' | 'line' | 'pie', title, x, y } | null,
  points: [{ label, value }],   // 已按上限裁剪
  omitted: number,              // 被裁掉的点数
  rowCount: number,
  truncated: boolean
}
```

四个约束，每条都有理由：

- **只存点，不存行。** 客户端要画的是 `(label, value)` 序列，不是原始结果。这让载荷与结果规模解耦：`maxResultRows` 提到 5000 也不会让元数据爆掉。
- **点数上限 120**（`MAX_CHART_POINTS`）。超过就截断并把数量写进 `omitted`，卡片会显示 "N points not plotted"，绝不假装画全了。
- **带 `kind` + `version`。** 客户端只认自己认识的那一版，其他一律回退到文本，避免两版共存时错解读。
- **`chart: null` 也是合法载荷。** 没要求画图的调用同样写元数据，客户端据此走文本分支，而不是靠「元数据缺失」猜。

## 客户端：一个 bundle，四个状态

`src/client/index.js` 是被打包的源，`scripts/build-client.mjs` 把它和 ECharts 拼成 `lib/client.js`：

```
window.__ModuleLoader__.load({ id: <包名>, factory: require => {
  var module = {exports:{}}, exports = module.exports
  var __echarts = (function(){ ...echarts.common.min.js... })()
  <src/client/index.js 的正文>
  return module.exports
}})
```

三个实现细节值得记住：

- **ECharts 内联，而不是走共享模块表。** 它不在客户端 baseline 里；仓库规则允许插件私有携带第三方实现库（`packages/client/AGENTS.md`：「Third-party implementation libraries outside the baseline may be bundled independently」）。用 698 KB 的 `echarts.common.min.js`（bar/line/pie + grid/tooltip/legend/title + dataZoom/toolbox/brush），而不是 1096 KB 的全量包。成品 712 KiB。
- **不能用相对 `require`。** 模块系统的 `require` 只解析平台表和已注册模块 id，同一 bundle 内的相对路径不成立。所以浏览器半必须是**一个** factory 正文；`require('react')` 可用（Platform 表里），其余全部自包含。
- **React 从平台表拿。** 不重复内联 React，也不声明 `dsh.client.external`（那会变成跨插件的值依赖，规则禁止）。

组件覆盖四个状态，因为 keyed slot 一旦认领 `duckdb_sql` 就**接管整行**：

| 状态 | 渲染 |
| --- | --- |
| `preparing` | 「DuckDB query / Preparing…」 |
| `start` | 「DuckDB query / Running…」 |
| `result` 且 `isError` | 「Query failed」+ 结果文本 |
| `result` 且有合法 meta | ECharts 图 + 「N rows · truncated · M points not plotted」 |
| `result` 但 meta 缺失/非法/异物 | 硬标题 + 结果文本（绝不空行） |

渲染只读 `block.meta` 与 `block.content`，不读会话状态、不发 RPC、不依赖时钟——这样历史回放与实时追加走同一条路径。

## 它是活图，不是图片

卡片里跑的是真实 `echarts.init()` 实例（canvas renderer），不是服务端渲染出来的图片，也不是 `<img>`。步骤代码不产出任何位图；历史回放时客户端用日志里的元数据重新 `init` 一次，得到的是同样可交互的实例。

（早期文档里放过三张 PNG，那只是**设计评审时**为了让读者不必启动宿主就能看到配色与排版，属于文档素材，不是运行时产物。现在已删除，避免与真实渲染混淆。）

## 交互

交互全部落在 ECharts 原生能力上，没有第二套自研交互协议：

| 交互 | 触发 | 说明 |
| --- | --- | --- |
| 读到精确数值 | 悬停 | `tooltip.trigger: 'axis'` + `axisPointer: 'cross'`（柱/线）或 `'item'`（环）；数值经 `valueFormatter` 统一成整数或两位小数 |
| 滚轮/拖拽缩放 | 图上滚动、横向拖动 | `dataZoom: inside`，始终可用 |
| 区间滑块缩放 | 拖底部滑条 | 点数 ≥ 13 时追加 `slider`，默认展示最新一段窗口（长序列最关心尾部） |
| 一键复位 | 工具箱 Reset | `toolbox.restore`，撤销缩放与选中 |
| 导出图片 | 工具箱 Save | `toolbox.saveAsImage`，2× 像素比、白底 |
| 以表格查看数据 | 工具箱 Data | `toolbox.dataView`（只读）——原生把序列渲染成表格，不必自己再写一个表格组件 |
| 框选缩放 | 工具箱 Zoom | 与滑块同条件开启，`dataZoom` 工具按钮 |
| 扇区选中/取消 | 点击扇区 | `selectedMode: 'multiple'` + `emphasis.scale` |
| 自适应宽度 | 列宽变化 | `ResizeObserver` → `instance.resize()` |

这也解释了为什么构建从 `echarts.simple.min.js` 换成 `echarts.common.min.js`：`simple` 里 `dataZoom`/`toolbox` 只作为选项名出现（计数 4/5），组件本身并未注册；`common` 才是真实现（计数 72/20）。这个判断不是靠字符串推断，而是加载两个 dist 后调 `getOption()` 对比：`simple` 拿不到 `dataZoom`，`common` 返回 `dataZoom: 1`、`toolbox: ok`。代价是 bundle 从 499 KiB 涨到 712 KiB。

## 视觉与主题

- 尺寸：容器高 240 px，宽度 100%，`ResizeObserver` 跟随列宽变化重排。
- 配色：从页面 CSS 变量读 `--dsw-alias-*`（label / border / brand / warning / success / danger），取不到才退回硬编码值，因此明暗主题跟随宿主而不用维护两套。
- 图表类型由模型选：`bar` 比较类别、`line` 看时间序列、`pie` 看占比。类型在 Host 侧用 enum 约束，非法值在 `execute` 阶段就被拒，不会静默降级。
- 空间分配：有滑块时 `grid.bottom` 让出 34 px 给它，无滑块时回收为 4 px，避免长序列把横轴标签挤掉。
- 生命周期：`echarts.init` 在 effect 内，卸载时 `dispose()`；`ResizeObserver` 一并断开。初始化失败时组件返回 `null`（不抛错，不让卡片崩溃）。

## 与文本渲染的关系

`output.render` 仍然生成表格 + 文本条形图，两个用途没变：

1. **模型读的是它**，不是图。模型看不到 canvas，所以数值必须留在文本里。
2. **卡片回退也用它**：元数据异常时显示同一段文本。

也就是说，图是给人看的增量，文本是模型与降级路径的基线。两者由同一份结果派生，不会漂移。

## 验收

| 编号 | 验收项 | 通过条件 | 证据 |
| --- | --- | --- | --- |
| C1 | Host 识别为客户端行 | 真解析器返回包名与 `lib/client.js` 路径 | `test/client-row.test.ts` |
| C2 | bundle 注册 id 正确 | id === package.json name | `test/client-bundle.test.ts` |
| C3 | 认领正确 slot | `{ name: 'tool.call.toolview', key: 'duckdb_sql' }` | 同上（stub ctx） |
| C4 | ECharts 已内联可用 | `buildOption` 产出合法 bar/line/pie option | 同上 |
| C5 | 元数据契约 | 点、上限、omitted、truncated 正确 | `test/tools.test.ts` |
| C6 | 坏元数据不炸 | kind/version/字段非法一律返回 null | `test/client-bundle.test.ts` |
| C7 | 点数上限 | 超过 120 截断并计数 | `test/chart-meta` 用例 |
| C8 | 线性可回放 | 只依赖 `block.meta` + `block.content` | 代码约束（无状态读取） |
| C9 | 可交互 | 缩放、复位、导出、数据表、交叉指针、扇区选中按配置产出 | `test/client-bundle.test.ts` 的「chart interactivity」 |
| C10 | 交互组件真注册 | `echarts.common.min.js` 的 `getOption()` 含 `dataZoom` 与 `toolbox` | 构建选型验证（见「交互」一节） |

C8 与像素级外观仍需在浏览器里确认一次：本组测试证明「Host 会服务这个 bundle、bundle 会认领这个 key、option 会带上交互配置、ECharts 确实注册了这些组件」，但「卡片在对话流里的实际观感与实际拖拽手感」要刷新页面确认。

## 运行与重建

```sh
cd dsh-duck-analytics
npm run build     # 重新生成 lib/client.js（改 src/client/index.js 后必须执行）
npm test
```

启动（仓库根目录）：

```sh
pnpm dsh web --patch ./dsh-duck-analytics/cordis.yml
```

改动客户端源后：先 `npm run build`，再刷新页面。浏览器半由 Client Modules 按 bundle 的文件元数据（mtime/ctime/size）判版本，重建即换版本；只改 Host 半则只需重载插件。

## 已知边界

- **bundle 712 KiB 里的 698 KiB 是 ECharts `common`。** 想再小需要按需构建（`echarts/core` + 具体图表与组件），那要引入打包器；当前环境没有可用的离线打包器，因此整包内联。这是可优化项，不是已优化项；换回 `simple` 能省 209 KiB，代价是丢掉全部缩放与工具箱交互。
- **只画单序列。** 多序列（同图多条线、堆叠柱）需要 `series` 字段与分组语义，等有真实需求再加，不预先设计。当前 `dataView` 与缩放在单序列下已经够用。
- **不写下钻、联动、自定义 formatter。** 交互只用 ECharts 原生能力，不引入自有交互协议，也不接受模型提供的 formatter 函数。
- **卡片接管整行**，因此 `duckdb_sql` 失去了通用工具行的折叠/检查器入口。这是有意的取舍：图比原始参数更值得占位。
