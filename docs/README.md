# DuckDB Analytics 插件：设计文档

这套文档替代原始设计稿 `DeepSeek-Harness-DuckDB-Analytics-Design.md`。原稿的结论（会话内嵌 DuckDB + 工具卡片 + `presentationMeta`）方向正确，但存在若干会直接导致编译失败或运行时失效的问题，以及一批过度抽象。本目录先做评审，再给出关系模型，最后是已实现的 MVP。

## 结论摘要

1. **原稿的 `output.schema` 写法非法**。`defineTool` 的 `schema` 收的是 `ValueSchemaSpec`（DSL），不是 JSON Schema：对象节点必须显式写 `additionalProperties`，可空联合必须用 `oneOf`（≥2 分支），没有 `type: ['object','null']` 这种形式。
2. **原稿把「每个 Agent 注册一套工具」当成隔离手段，这是过度设计**。工具全局注册一次即可，每次调用由 `exec.agent` 指明归属；仓库内先例是 `dsh-tool-todo`（全局注册 + `exec.agent.session`）。真正需要按 Agent 隔离的只有资源（数据库），不是注册动作。
3. **原稿的 SQL 正则黑名单既误杀又漏检**。它漏掉了 `SELECT * FROM 'sales.csv'`（DuckDB 允许字符串字面量当表名，直接读文件），也漏掉 `glob()`、`sniff_csv()`；同时会把列名叫 `set`、字符串里出现 `drop` 的合法查询拒掉。MVP 改成「DuckDB 自己的 parser 判定语句数 + 词法层判定表位置与读取函数」。
4. **ECharts 卡片已实现**。第一版判断「scratch 插件做不了浏览器半」在机制上成立（必须存在 `lib/client.js`），但离线生成这条路是通的：`dsh.client` 声明 + 手写 `factory(require)` bundle + 内联 ECharts，Host 用最近的 `package.json` 把同一个 Loader 条目识别成客户端行。详见 [04](04-图表卡片-ECharts.md)，并由 `test/client-row.test.ts` 调用 Host 真实解析器固化。
5. **MVP 已实现并自测通过**：三个工具（`duckdb_load` / `duckdb_tables` / `duckdb_sql`）、每会话独立内存 DuckDB、只读 SQL 门禁、行数/超时/内存上限全部来自配置，77 个测试用例（1 个因宿主不允许创建符号链接而跳过）。

## 文档地图

| 文档 | 回答什么 |
| --- | --- |
| [01-设计评审.md](01-设计评审.md) | 原稿哪些地方错了、证据在仓库哪里、怎么改 |
| [02-关系模型.md](02-关系模型.md) | 用户 / Agent / 工具 / 插件四者关系，状态归属，隔离与授权边界，明确不做的抽象 |
| [03-MVP-设计与实现.md](03-MVP-设计与实现.md) | 已实现的第一版：范围、工具契约、数据流、安全模型、生命周期、测试与验收 |
| [04-图表卡片-ECharts.md](04-图表卡片-ECharts.md) | ECharts 卡片如何进入对话流：客户端行解析、bundle 协议、元数据契约、交互清单、回放 |
| [05-折叠问题分析.md](05-折叠问题分析.md) | 图表为什么被折进过程区、折叠的四层判定、turn-tail 为什么不受影响、已实施的投影方案 |

## 代码与运行

代码就在 `dsh-duck-analytics/` 下（`src/`、`src/client/`、`scripts/`、`test/`、`data/`、`lib/`），由 `cordis.yml` 里的单条本地插件条目同时提供 Host 与浏览器两半。

```sh
# 改了 src/client/index.js 之后必须重建浏览器半
cd dsh-duck-analytics && npm run build

# 只跑本插件测试（沙箱内无法用 node --test 的子进程模型，见 03 文档）
cd dsh-duck-analytics && npm test

# 类型检查
cd dsh-duck-analytics && npm run typecheck

# 在仓库根目录启动（dataRoot 已在 cordis.yml 中配置为 dsh-duck-analytics/data）
pnpm dsh web --patch ./dsh-duck-analytics/cordis.yml
```

数据目录里有一个可直接试的 `data/sales.csv`（20 行、两个区域、十个月份），对应提问示例：

> 加载 sales.csv，按月汇总销售额并画折线图，指出增长最快的区域。
