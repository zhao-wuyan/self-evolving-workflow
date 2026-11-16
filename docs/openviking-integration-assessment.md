# OpenViking 接入兼容性与最小改造评估

**能接。[INFERENCE] 作为外部知识与长期记忆层，兼容度高；直接替换现有底座，兼容度低。推荐外置桥接，尽量不改项目核心。**

## 1. 兼容在哪里

当前项目的核心是 **Session / Run 执行治理**，OpenViking 的核心是 **知识存储、检索与长期记忆**，两者更适合互补。

| 能力 | 兼容判断 | 边界 |
|---|---|---|
| 文档、经验、跨项目知识检索 | 高 | OpenViking 提供 `find/search/read`，适合补充现有知识来源 |
| 工作记忆 | 较高，需要映射 | 本项目 Memory 检索已是异步接口，但数据结构、ID 和来源字段不同 |
| Wiki 正式约束 | 不能直接替换 | 当前约束有适用范围、状态和治理流程，不能用语义召回代替完整约束清单 |
| CodeGraph | 不建议替换 | 导入代码、检索代码，不等于提供准确的调用图与路径追踪 |
| Session / Run | 不建议替换 | OpenViking Session 管会话与记忆提取，不是这里的任务状态机 |

技术栈没有明显障碍：项目要求 Node.js ≥ 22.16，OpenViking 官方 TypeScript SDK 支持 Node.js ≥ 18，也能直接调用 HTTP API。[官方接口](https://docs.openviking.ai/en/api/01-overview)

但它**不是已经预留好、配个 URL 就能切换的插件架构**：

- `SearchSources` 直接绑定 `MemoryStore`、`Wiki` 等具体类：`src/search.ts:14`。
- Run MCP 直接创建本地 `MemoryStore`：`src/workflow-mcp.ts:28`。
- `knowledge-reads/1.0` 的来源类型固定，随意新增 `openviking` 会被旧版校验器拒绝：`src/knowledge-reads.ts:95`。

## 2. 最小修改：推荐独立 Bridge

**[INFERENCE] 如果允许通过额外工具或 Skill 调用，可以做到零核心源码修改，但不是零集成代码。**

桥接程序独立维护，承担三件事：

1. **远端检索与精读**：限定项目范围查询 OpenViking，再读取实际正文，不能把 L0/L1 摘要当作原文证据。
2. **按需导入本地快照**：调用公开的 `MemoryStore.putMany()`，保留远端 URI、正文哈希和获取时间，不直接写 SQLite。
3. **沿用原有治理**：导入内容先作为非权威工作记忆；需要成为正式参考或约束时，仍走 `wiki propose/apply`。

现有 `context`、Memory 读取和 Run 回执继续工作，不必改 Session / Run、CodeGraph 或 Skill 版本绑定。

**代价要说清楚：**

- 本地快照不是远端实时真源，需要刷新、失效规则。
- 原有 Run 回执证明的是“读过本地快照”；远端获取过程由 Bridge 另外记录。
- 单纯给宿主挂 OpenViking MCP，虽然改动更少，但不会自动进入 Evolve 的知识回执。[官方 MCP 接口](https://docs.openviking.ai/en/guides/06-mcp-integration)

如果要求 **原来的 `evolve context` 和 Run MCP 自动直查 OpenViking**，则需要小范围源码改造，主要接缝是 `search.ts`、`knowledge-cli.ts`、`workflow-mcp.ts`。这比外置桥接更原生，但维护冲突也更多。

## 3. 怎样兼容上游后续更新

建议同时隔离本项目和 OpenViking 两边的变化：

- **Bridge 独立成包**，不修改 `src/upstream/*`、`dist`、`node_modules` 或随包 Skill。
- **只依赖公开 CLI、包导出和 HTTP API**，不引用内部 `dist/...` 文件，不直接读写运行数据库。
- **不改现有回执协议**，不把外部资料冒充本地正式约束。
- **固定兼容版本范围**，用少量契约测试检查返回结构、项目隔离、正文哈希及原有本地路径。

这样能把升级适配集中在 Bridge，**降低合并冲突，但不能保证未来破坏性更新永远零维护**。

**取舍：先做外置、可选、按需快照的知识桥接；不做全量替换，也不先做双向同步。** 这是最符合“最小修改、持续跟上游”目标的路线。

## 4. 评估范围

本次评估已核对源码、官方 API 和 npm SDK。评估时宿主 OpenViking 插件连接正常，但尚未进行项目接入联调；未修改运行代码，未运行构建或测试。
