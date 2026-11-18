# Evolve 知识路由与规则

本文件定义 Evolve 统一知识模型、ID 边界、搜索回执、L3 初始化、旧知识迁移与自进化分流规则。Wiki、Session/Skill 收尾沉淀、候选审查和发布共用统一 Wiki 与 `evolve` CLI（源码仓库内使用 `node dist/workflow-cli.js`）。

## 统一 Wiki 条目

正式知识只进入 Wiki 条目，原 Spec 和 Knowhow 通过属性表达差异：

- `mode: constraint` — 执行约束、质量门禁和适用规则。
- `mode: reference` — 经验、方法、模板、术语和可选建议。
- `status: active|needs_review|deprecated` — 生命周期状态。
- `scope` — 默认 `project`，也可用 `task:<kind>` 或 `path:<glob>` 限定适用范围。
- `categories`、`tags`、`keywords` — 用于查询和路由，不能替代 `mode` 与 `scope`。
- `sources` — 必须可回查到完成回执、消息锚点或迁移来源。

正式知识统一通过 `evolve wiki` 命令写入 `wiki/`，禁止直接创建或修改历史知识目录或 `wiki/entries/`。

## 核心规则

1. 先识别操作，再识别目标：`查、搜索、读取、引用` 进入 `read`；`收尾、沉淀、harvest` 进入 `closeout`；`审查、重复、冲突、候选` 进入 `review`；`发布、批准、应用` 进入 `publish`；`迁移、导入` 进入 `migrate`。
2. 只有明确要求发布或应用时才执行写入。检索结果、Closeout 候选、审计结果和回溯信号都只是证据。
3. Session 收尾和独立 Skill 收尾进入同一 Closeout 流程，只使用完成回执中的证据范围，不从未授权工作区文本补证。
4. Closeout 提取可复用方法后，先核对适用条件、验证证据和现有条目关系，再决定追加来源、创建候选、更新条目或标记冲突。
5. 同一内容在唯一活跃 `reference` 条目中重复验证时，可以只追加 `sources`；正文、作用域和模式变化必须走 Wiki 提案。
6. `constraint` 与 `reference` 发生冲突时保留双方证据并创建待审查关系，不自动覆盖活跃条目。
7. 归因到具体 Skill、版本、读取文件与证据的信号转交 `workflow-evolve`；项目级规则与跨任务经验留在 Wiki。
8. 候选只有在需要新契约、新产物、跨 Skill 路由、至少 3 个稳定步骤或明确要求新增 Skill 时才进入 `ew-skill-design`；单条指令与条件链接继续由 `workflow-evolve` 处理。

## Read 与 ID 边界

按查询类型选择最窄入口；约束读取带适用上下文，参考读取保留条目 ID 和来源。

```text
evolve --root <project> wiki constraints --category <category>
evolve --root <project> wiki references "<topic>" --task <kind>
evolve --root <project> wiki get <entry-id> --resolved --task <kind>
evolve --root <project> wiki search "<query>"
evolve --root <project> context "<query>" --task <kind> --session <session-id> --include-memory
evolve --root <project> context "<query>" --session <current-session-id> --memory-session <historical-session-id> --include-memory
evolve --root <project> context "<query>" --context-file <context.json> --include-memory
evolve --root <project> search "<query>" --scope memory --scene <scene> --type <type> --reads <knowledge-reads.json>
```

- 标准顺序为 `search → get`：搜索返回摘要与稳定 `knowledge_id`，精确读取（`wiki get <id> --resolved` / `memory get <id>`）才返回完整正文、作用域和来源。
- 写入接口（`propose`、`changes`、`apply`）必须使用规范化条目 ID、候选 ID 或变更 ID 并校验基线哈希，不接受别名。
- 零命中时保留查询条件与空结果，禁止把“缺少参考”误写成新的 `constraint`。

## 个人跨项目经验（可选）

个人经验在 OpenViking 私有 `resources/evolve/personal-experience` 下独立保存，不是原生会话采集、项目 release、Memory 或正式 Wiki 约束。默认没有配置，不改变现有项目行为。

在目标 Git 仓库根目录运行 `evolve experience enable`。它用现有 OpenViking 连接确认身份，自动创建或更新用户级 `~/.evolve/experience.json`，只把当前工作树真实路径加入采集名单，不保存或复制 API key。用 `evolve experience status` 查看开关；`evolve experience disable` 在本地关闭当前仓库，不删除远端经验。隔离测试可用绝对路径的 `EVOLVE_EXPERIENCE_CONFIG` 覆盖配置位置。

未启用的仓库可查询已有参考，但不贡献候选；仓库内文件不能代替用户授权。由执行 `ew-verify` / `ew-test` 的 AI 根据实际通过的检查写入提炼字段，不另起模型；只有完成 Session 后的封存证据可被列入 `evolve experience pending`。候选审阅及发布规则见[收尾协议](closeout-protocol.md)。已有项目需更新并提交对应 Skill，已绑定的 Run 不自动换版本。

项目约束优先；当语言、框架及其版本已从当前项目确认，且任务确实有参考需求时，用 `evolve experience search python python@3.12 "并发延迟"` / `evolve experience get python python@3.12 <id>`。在 OMP 中可用 `evolve_workflow` 传对应的 `argv`；不能通过该工具审批或发布。查询词会发给 OpenViking，不包含项目机密。结果应核对适用条件、验证摘要和冲突关系，以正文哈希记录引用；不混入项目 Knowledge Gate，也不当作授权。


## 搜索回执与 `session-priors`

Run MCP 的 `wiki_context` 与 `wiki_reference` 自动记录 `knowledge_reads/1.0` 并在封存时写入回执。分析 Run 还会把已读 Wiki 正文和约束封存为 `session-priors`；后续 Run 通过 `artifact-read` 打开该产物后，`priors_reuse` 自动记录产物 ID、哈希和原 Run ID。

- `searches[]` 记录查询词、阶段过滤条件、返回 ID 与命中数。
- `reads[]` 记录精确读取及其 `from_search_id`（或 `priors` 来源）、`content_sha256` 与 `version`。
- CLI 模式下跨调用复用同一个 `--reads <run_dir>/knowledge-reads.json`，并在精确读取时传入 `--from-search <search-id>`；无搜索时不伪造记录，零命中保留 `returned_ids: []`。

## L3 初始化与无侵入回溯

- 初始化时调用 `evolve context` 加载 L3 Wiki 约束与参考（返回 `agent-memory-envelope/1.0`），不读取宿主原始历史文件。
- `context --session` 只标记当前上下文；筛选历史工作记忆需显式使用 `--memory-session`。
- 回溯优先消费已提交的 Session/Run 回执；需要补充对话历史时再按显式配置的 `host_kind` 与根目录读取并转换为 `transcript-evidence/1.0`。

## 迁移旧 Spec 与 Knowhow

在旧项目根目录预览迁移条目与待审查数，核对后追加 `--apply` 写入并建索引：

```text
evolve knowledge import [<source-project>] [--root <target-project>] [--project <source-id>] [--knowhow-only] [--apply]
evolve knowledge import --global [--knowhow-only] [--apply]
evolve wiki migrate <legacy-root> [--scope project|global|team|personal] [--knowhow-only] [--apply]
```

- `--knowhow-only` 仅迁移 `.workflow/knowhow/`；`--global --apply` 导入用户全局 `~/.evolve` Wiki（用 `evolve --root "<home>/.evolve" context "<query>"` 查阅）。
- 重复导入保留既有相同条目并保留原文件出处；带仓库限制的条目可用 `--repository "<repo-uuid>"` 检索。
