# dsh-duck-analytics

Per-conversation DuckDB analytics tools for DeepSeek Harness, with interactive ECharts charts rendered in the conversation.

- 设计文档：[`docs/`](docs/README.md) —— [设计评审](docs/01-设计评审.md) → [关系模型](docs/02-关系模型.md) → [MVP 设计与实现](docs/03-MVP-设计与实现.md) → [ECharts 卡片](docs/04-图表卡片-ECharts.md) → [折叠问题分析](docs/05-折叠问题分析.md)。
- 工具：`duckdb_load`（导入 CSV/Parquet/JSON）、`duckdb_tables`（列出已加载表）、`duckdb_sql`（单条只读 SQL，可画 bar/line/pie）。
- 图表是活的 ECharts 实例（canvas），不是图片：悬停读数、滚轮/滑块缩放、工具箱复位/导出/数据表、环图扇区点击选中。
- 图在**消息区**：插件注册了一个会话节点（`duckdb-chart`，`groupTree: 'turn'`），Turn 结束、过程区折叠后依然可见。
- 本仓库独立于 deepseek-harness：只通过 `peerDependencies` 里的 DSH 包与宿主共享实例，不含任何指向 harness checkout 的路径。

## 安装

作为 DSH bundle 安装进某个 profile（推荐）：

```sh
dsh plugin --profile demo add github:zhaoyii/dsh-duck-analytics
# 或在本地 checkout 旁：
dsh plugin --profile demo add ./dsh-duck-analytics
```

安装后 `cordis.patch.yml` 的那一行会把 `dataRoot: ./analytics-data` 交给插件（相对启动目录）。要指向自己的数据，在你的 profile 的 `cordis.patch.yml` 里用同一 `id` 覆盖 `config`：

```yaml
- id: duckdb-analytics
  name: dsh-duck-analytics
  config:
    dataRoot: /absolute/path/to/your/data
```

**本地开发**（不安装，直接加载 checkout）：

```sh
npm install
npm run build     # 编译 Host 半到 lib/*.js，并生成 lib/client.js
# 在 harness checkout 根目录：
pnpm dsh web --patch ./dsh-duck-analytics/cordis.yml
```

## 构建产物 `lib/`

`lib/` 是构建输出，但**必须随仓库提交**：

| 文件 | 作用 | 缺失后果 |
| --- | --- | --- |
| `lib/client.js` | 浏览器半；`package.json` 的 `exports["./client"]` 指向它 | 宿主识别到 `dsh.client` 却读不到 bundle，**客户端行激活失败**，图不出现 |
| `lib/index.js` + 其余 `lib/*.js` | Host 半；patch 行的包名解析到这里 | 插件无法加载（普通 `dsh` 进程不转译 TypeScript） |

git 安装不会运行本仓库的构建（也没有可靠的 `prepare` 授权路径），所以产物入库是这里的有意取舍：`git add` 之后 `dsh plugin add github:...` 直接可用。改过 `src/` 或 `src/client/index.js` 后请重新 `npm run build` 并提交。

## 自测

```sh
npm test        # 86 用例（1 个因宿主不允许建符号链接而跳过）
npm run typecheck
```

测试直接跑 TypeScript 源码（Node 类型擦除），DSH 包来自 `devDependencies`，因此不需要 harness checkout。
