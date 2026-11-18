# Self-Evolving Workflow 规划

讨论日期为 2026 年 11 月 13 日。方案基于 Maestro2 源码、当前知识引擎，以及与 Agy 对 Wiki 和 Session/Run 架构的评审。文中的数据结构和运行流程用于后续实现评审。

当前工作流入口使用 `ew-` 命名。文中的 Maestro 命令和环境变量记录早期迁移方案，当前执行以 EW 工作流目录与 `evolve` CLI 为准。

## 1. 目标与架构

Self-Evolving Workflow 延续 Maestro2 的 Session、Run 和 Skill 生命周期。当前项目提供独立的 `evolve` 控制器，并用从 TencentDB Agent Memory 提取的本地引擎处理错误、用户纠正和验证结果，支持按证据回放和改进 Skill。

首版用一个项目内可控的 Skill 跑通完整流程，覆盖 Maestro Session 收尾、独立 Skill 收尾、知识检索与更新，以及 Skill 补丁的生成、回放、应用和回滚。

```text
Maestro Session 完成 / 独立 Skill 明确结束
  → 完成回执与已冻结的证据
  ├─ 多层沉淀 Skill → 匹配 Wiki → 补证 / 候选发布 → 后续任务检索与加载
  └─ 回溯工具 → 自进化 Skill → 按优先级生成补丁 → 回放与应用
```

| 组件 | 职责 |
| --- | --- |
| Evolve Session/Run | 管理步骤链、执行状态、决策、产物和完成回执，校验已绑定的执行契约。 |
| 编排 Skill 与宿主 | Skill 入口负责路由和编排。宿主执行端沿版本固定的 Markdown 链接读取 Skill 及其流程。 |
| MemoryCore L1 | 从有边界的任务证据中提取情境和经验，保留来源消息。 |
| MemoryKnowledge | 提供 Wiki 全文检索和页面关系。涉及代码时，可用 CodeGraph 定位文件、符号和调用关系。 |
| Evolve | 负责回执消费、证据校验、Wiki 条目、候选更新、旧库迁移和 Skill 改动的验证流程。 |

### 上游版本与复用范围

截至讨论日期，TencentDB Agent Memory 最新正式发布为 `v2.0.3`（`084bed4`），默认分支为 `42d4cde`，与本地提取基线一致。两者之间的 8 个提交未改动本方案用到的 L1 提取、Skill 提取及 Wiki 引擎目录。首版固定完整提交 `42d4cde50c5a83182fced8c584f9ddb32a620615`，继续复用本地的 MemoryCore L1 与 MemoryKnowledge Wiki/CodeGraph，升级时按提交差异和集成测试显式更新。 [上游发布](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases/tag/v2.0.3) · [提交差异](https://api.github.com/repos/TencentCloud/TencentDB-Agent-Memory/compare/v2.0.3...42d4cde50c5a83182fced8c584f9ddb32a620615) · [本地 L1 提取](/D:/evolve_workflow/src/upstream/l1-extraction.ts)

上游提供两处可直接借鉴的能力。Wiki 的 Markdown、全文索引和页面链接继续复用。Skill 提取沿用相关 Skill 检索与评审的思路，模型工具只输出补丁提案。上游 `skill_create` / `skill_patch` 的写入时机早于评审结果返回，Evolve 的写入权由独立的应用步骤持有。整体以本地库运行。 [本地 Wiki](/D:/evolve_workflow/src/wiki.ts:42) · [上游 Skill 工具](/D:/evolve_workflow/ref/TencentDB-Agent-Memory/MemoryCore/src/core/skill/skill-tools.ts:122)

## 2. Session/Run 与 Skill 编排

项目 Skill 位于 `skills/`。入口为 `ew-orchestrate`，包含 `ew-companion`、`ew-brainstorm`、`ew-analyze`、`ew-plan`、`ew-execute` 和 `ew-review` 六个步骤。`ew-odyssey` 与 `ew-skill-design` 按需调用，`ew-swarm` 提供并行探索。

### Evolve 原生 Session/Run

Session 管理目标、步骤链、决策和同一 Session 内的产物关系。Run 固定本次执行的 Git 版本和输入工件。Evolve 在 `.agent-memory/workflow.db` 的同一事务内封存产物并记录执行回执，Agent Memory 只读消费该数据库的证据。协调器调用 `evolve run create`、`run get`、`run check`、`run complete`、`run decide` 和 `session complete`，以返回的定位、修订号和续步为准。旧 Session 仍可按其既有回执查询与沉淀。 [Evolve 运行手册](/D:/evolve_workflow/skills/ew-orchestrate/references/orchestrator-run-loop.md)

### Skill 自带流程，用 Markdown 链接连接

各 Skill 的 `SKILL.md` 负责入口、适用条件和简短执行说明。长流程、准备指导和分支步骤放在本包的 `references/` 或 `phases/`，用 Markdown 相对链接按需读取。角色与脚本也随对应 Skill 打包。共享 Session/Run 说明保留一份，供需要持久化执行状态的 Skill 引用。下面是目标结构示例。

```text
skills/
  ew-orchestrate/SKILL.md
  ew-orchestrate/steps/ew-analyze/SKILL.md
  ew-orchestrate/steps/ew-analyze/references/workflow.md
  ew-odyssey/SKILL.md
  ew-odyssey/references/
  ew-swarm/SKILL.md
  ew-swarm/roles/
  ew-swarm/scripts/
```

例如，`ew-orchestrate` 用 `[分析 Skill](steps/ew-analyze/SKILL.md)` 指向分析 Skill，分析 Skill 用 `[执行流程](references/workflow.md)` 指向下一份文件。第一跳由协调器从当前步骤的可信 Skill 入口确定。执行端以实际加载文件所在目录为基准解析后续链接。执行引用限于显式选定的 Skill 包和声明引用的共享说明。Wiki、任务报告和普通正文里的链接供读取，是否执行下一步仍由 Session 步骤链与续步决定。

### 移除新 Run 的 Skill 加载

| 层 | 改动 |
| --- | --- |
| 协调器 | 通过可信的 Skill 解析入口选择具体包，绑定稳定 Skill ID、入口 Markdown 路径和包版本。该入口从已选定的固定版本读取 `SKILL.md` frontmatter，规范化机器契约并记录绑定。步骤发现与调度使用同一解析结果。 |
| Session/Run Runtime | 保存步骤执行引用、已绑定的机器契约快照及其哈希。继续按该快照校验参数、产物、门禁和链变更。新路径的 `next`、`brief`、`check` 与 `complete` 消费记录的引用和契约，去掉扫描 `prepare/`、`workflows/`、查找 `SKILL.md` 和组装指导正文的逻辑。 |
| 宿主执行端 | 从 Run 返回的引用读取对应版本的 Skill，再沿 Markdown 链接加载本次需要的流程。用于执行提示的 `prepare` 内容和文字完成清单随 Skill 读取。 |

当前 `run check` 和产物封存会重新解析 Skill 契约，启动包也会解析旧目录生成 `guidance`。切换时先用绑定的契约快照接替这些校验。快照保留现有参数、输入、输出、进入与退出门禁及允许的链效果。可信绑定入口可由现有 CLI 在同一进程调用。Runtime 从此入口登记的绑定取得契约，核对 Skill 身份、版本及契约摘要，按快照执行验证。普通调用者和工作者提交的契约、报告及 Markdown 正文均无法改变这份绑定。项目约束仍按 Wiki 的有效范围加载。 [现有步骤解析](/D:/maestro2/src/run/contract.ts:614) · [现有启动包](/D:/maestro2/src/run/v3/mutation-engine.ts:1072) · [现有完成检查](/D:/maestro2/src/commands/run-v3.ts:503)

### 版本固定、恢复和缺失引用

首个样本选择受 Git 管理的项目 Skill，以可回取的仓库提交、包路径及目录树 ID 固定整包版本。包内文件从该提交读取，工作树修改等提交并重新绑定后才生效。公共说明如参与本次执行，随绑定记录其可回取版本。执行端通过受控读取入口记录实际读取的相对路径和 Git blob ID。`run check` 和完成步骤核对受控读取记录与已绑定的包清单，再用原契约检查结果。自进化样本可先在隔离工作区把候选固定为测试提交，再由宿主回放。未纳入 Git 的安装包后续可用按内容寻址、可回取的整包快照走同一约定。

已有 Run 恢复时使用原绑定和契约，并在该 Run 仍需恢复期间保留对原版本的读取能力。Skill 发布新版本后，新的调用可以绑定新版，旧 Run 继续引用原版。缺失版本、断链、路径越界或同名来源不明时，停止执行该步骤，输出确切引用与原因。优先补齐原版本。若确认需要改用新版，则通过现有取消或重试流程创建带新绑定的 Run，保留原尝试及已封存产物。迁移前创建、尚无新绑定的 Run 继续走原解析兼容路径。

### 合并 Next、Ralph 和现有 Maestro 入口

使用 `ew-orchestrate` 作为意图入口，使用 `evolve` 执行 Session 和 Run 操作。正常模式与自动模式共用一个执行循环，协调器逐次读取续步和最新修订号。自动策略采用授权范围内的低风险选择，涉及风险升级或门禁未解决时保留人工决策。

| 入口用法 | 行为 |
| --- | --- |
| `ew-orchestrate` 的任务入口 | 轻量任务进入 Companion；需要产物交接时建立 Session 步骤链。 |
| `ew-orchestrate` 的 `--auto` | 使用同一循环，允许授权范围内的有限重试与低风险调整。 |
| `ew-orchestrate` 的 `--resume <session-id>` | 用 `evolve session get` 和 `evolve run get` 恢复原 Run、决策和产物绑定。 |

迁移期的 Next 和 Ralph 入口不再作为独立 Skill 分发。原有路由、自动策略、目标修订和恢复规则统一收入 `ew-orchestrate`，由 `--auto` 与 `--goal` 选择执行模式。旧命令名只作为外部兼容映射，不再拥有独立的指令副本。 [EW 编排入口](/D:/evolve_workflow/skills/ew-orchestrate/SKILL.md:45) · [目标长链策略](/D:/evolve_workflow/skills/ew-orchestrate/references/goal.md:8)

### 专用 Skill 与知识闭环

| Skill | 职责 |
| --- | --- |
| 元 Skill | `ew-skill-design` 负责设计、迁移和校验 Skill 包，按需引用契约和回放说明。`evolve skill validate <id>` 检查 Git 绑定、契约和必读链接。 |
| Odyssey | 保留长期诊断、修复和复验的迭代策略。各模式与共享阶段随 Odyssey 包分发，Session/Run 管理外层进度。 |
| Swarm | 保留并行探索、评分及迭代收敛。协调器提交 Run 结果，角色、迭代文件和脚本由 Swarm 管理并随包分发。 |

知识查询、Session/Skill 收尾、候选审查、迁移和 Wiki 发布统一由 Evolve 知识路由负责。`workflow-closeout` 保留为旧调用名的兼容入口，不再维护第二套知识规则。自进化仍保留独立入口，只有能归因到 Skill 行为的信号才进入该流程。元 Skill 使用 Memory 回溯为改动定位证据，Skill 变更按第 5 节回放、应用和回滚。 [知识路由](/D:/evolve_workflow/skills/ew-orchestrate/references/knowledge-route.md) · [元 Skill](/D:/evolve_workflow/skills/ew-skill-design/SKILL.md) · [Odyssey 模式](/D:/evolve_workflow/skills/ew-odyssey/SKILL.md) · [Swarm 包内引用](/D:/evolve_workflow/skills/ew-swarm/SKILL.md)

## 3. 统一 Wiki

### 条目存储

每个项目用 `wiki/entries/<稳定 ID>.md` 存放正式条目。文件名就是条目的稳定 ID。标题、主题和 `mode` 变化时复用原路径。每页承载一条能够独立引用和更新的知识。用 `tags` 和 `[[entries/<id>]]` 组织主题，主题导航可按需从索引生成。

Markdown 是正式知识的唯一来源，SQLite 全文及关系索引可以重建。初始执行时按作用域解析约束，再按任务检索参考。生效约束的选择以作用域和状态为准，全文检索排名只用于参考条目的相关性排序。

配置 Evolve 后，用 `maestro wiki references "<主题>" --json` 查询项目和有权访问的共享 Wiki。结果按仓库返回，保留条目 ID、来源和可见条目之间的关系。用 `maestro wiki reference <id> --repo <仓库 UUID 或别名> --json` 打开指定条目。两次调用可带相同的 `--task` 和 `--path`。参考查询读取当时适用的活跃条目，约束查询仍从 Run 快照读取。 [Wiki 命令](/D:/evolve-maestro-runtime/src/commands/wiki.ts)

完成约束比对的项目可用 `MAESTRO_EVOLVE_CONSTRAINTS=1` 启用新读取入口。版本化 Skill 的新 Run 在分派时按 Skill ID、命令名和当前仓库 UUID 固定候选约束，再按 Skill 的 `wiki_categories` 选出初始规则。有待确定文件的规则随 Run 保存，在文件确定后用 `maestro run wiki-constraints <run-id> --session <session-id> --path <file> --json` 筛选。恢复同一 Run 时沿用分派时的快照。`analyze` 和 `plan` 默认选择 `arch`，`execute` 默认选择 `coding`，涉及 UI 的任务可同时选择 `coding` 和 `ui`。已启用 Wiki 的 Run 即使得到空列表，也沿用该次查询结果。

### 条目格式

| 字段 | 含义 |
| --- | --- |
| `title` | 能独立说明条目内容的短标题。 |
| `mode` | `constraint` 表示执行约束，`reference` 表示可参考的经验。 |
| `status` | `active` 为当前版本，`deprecated` 供历史查询，`needs_review` 用于切换前尚待核实的条目。 |
| `scope` | 适用项目范围。项目全局用 `project` 显式声明，局部可用 `path:<glob>` 或 `task:<kind>`。列表中的范围是可独立命中的适用条件。缺少上下文的局部范围保持未命中。旧复合条件需要按原语义核对后再切换。 |
| `categories`、`repositories` | 可选的附加范围。`categories` 对应旧规则的类别读取，`repositories` 使用消费方的持久化仓库 UUID。规则还需满足 `scope`。 |
| `keywords` | 可选的显式关键词。指定关键词时精确匹配，忽略大小写，可跨类别命中。未设置时，可在适用类别内按正文匹配。结构化旧 Spec 无关键词时保留空列表。 |
| `sources` | 可回查的证据引用。任务证据指向完成回执与具体片段，迁移证据指向原项目、文件和条目锚点。 |
| `tags`、`aliases` | 可选。前者用于主题或旧子类型，后者保留来源项目内的旧身份。 |

下面是格式示例，`sources` 中的值为占位。

```markdown
---
title: 数据库迁移前执行预检
mode: constraint
status: active
scope: [task:db-migration]
sources:
  - "<完成回执中的可回查证据引用>"
---

执行数据库迁移前先运行 `--dry-run`。预检通过后才执行迁移。
```

约束正文写适用条件、必须采取的动作和必要例外。参考正文写触发情况、做法和验证方法。两种模式共用正文格式。经验升为约束时，如果讲的是同一个命题，在明确确认后更新原页的 `mode`，保留 ID、证据和 Git 历史。原有经验包含独立的操作细节时，可保留经验页并链接约束页。

`sources` 用于回查任务证据，写入前校验引用能定位到对应回执。已有图谱从正文 `[[…]]` 解析页面间关系。自动补证只追加 `sources`，Wiki 页面间的关联在正文显式表达。 [Wiki 索引与关系解析](/D:/evolve_workflow/src/wiki.ts:42)

### Search 与 Get/Query 接口边界

统一知识接口把候选发现和精确读取分开。Search 不接收条目 ID，Get、Query 和 Reference 必须接收条目 ID。

| 接口类别 | 规划签名 | ID 要求 | 返回内容 |
| --- | --- | --- | --- |
| 候选搜索 | `search(query, filters?)` | 不接收 `knowledge_id` | 摘要、稳定 `knowledge_id`、相关性、来源摘要和关系 ID |
| 参考搜索 | `kb search --kind reference(query, context)` | 不接收 `knowledge_id` | 满足 `mode=reference`、状态和作用域的候选摘要 |
| 约束解析 | `kb list --kind constraint(context)` | 不接收条目 ID | 当前上下文生效的约束全文、`knowledge_id`、内容哈希和作用域 |
| 精确读取 | `get(knowledge_id)` 或 `query({ id: knowledge_id })` | 必须接收稳定 ID | 单条完整正文、属性、来源和历史状态 |
| 受控参考读取 | `reference(knowledge_id, context)` | 必须接收稳定 ID | 通过当前作用域和共享授权复验后的参考正文 |
| 变更接口 | `propose`、`changes`、`apply` | 必须使用规范化条目 ID、候选 ID 或变更 ID | 提案状态、基线哈希、变更前后内容和应用回执 |

标准读取时序是 `search → get/query`。Search 只承担发现职责，返回摘要和 ID。Get/Query 承担精确读取职责，返回完整内容。Search 结果中的 ID 是后续操作的稳定引用，不能反向成为 Search 的必填参数。约束读取使用上下文匹配，不用条目 ID 替代作用域解析。

### 阶段化搜索与 `knowledge_reads`

各阶段通过 Skill frontmatter 的 `search_profile` 声明默认检索画像。`brainstorm` 关注架构参考与学习案例，`analyze` 关注架构约束和纠正经验，`plan` 关注拆解方法与碰撞风险，`execute` 关注目标路径和错误修复经验，`review` 关注评审规范、回归和历史缺陷。`session-priors` 只缓存已经读取的 ID 和已解决的作用域，不阻断后续阶段新增作用域的搜索。

查询默认保持无状态。显式使用 `--trace` 时，Agent Memory 返回 `knowledge_reads/1.0`，记录 `constraints_bound`、`searches` 和 `reads`。`searches` 记录查询词、过滤条件、返回 ID 和命中数。`reads` 记录通过稳定 ID 完成的 Wiki 或 Memory 精确读取，并保存 `from_search_id`、内容哈希和版本。Run 封存时把该结构放进 `result.knowledge_reads`，Review 和自进化据此区分漏搜、零命中、命中未读与读取后仍失败。

### Agent Memory 多 Agent 接口规划

Agent Memory 作为宿主无关的工具基础设施。Codex、Agy、Claude 和其他 Agent 保留自己的 system prompt，通过 `evolve` CLI 调用统一接口。Agent Memory 的 `agent-memory/2.0` 提取提示词只用于后台窄推理算子，不注入宿主 system prompt。

聚合搜索默认返回统一排序列表，`--mode context` 返回 `evolve-context/1.0` 任务上下文信封，字段如下。

```json
{
  "schema_version": "evolve-context/1.0",
  "mode": "context",
  "query": "<query>",
  "trust_boundary": "untrusted_evidence_data_only",
  "context_scope": {
    "session_id": "<optional>",
    "task_kind": "<optional>",
    "paths": []
  },
  "constraints": [],
  "references": [],
  "episodic": [],
  "code": []
}
```

字段规则如下。

- `id` 是条目稳定身份；所有命中均含 `source`、`kind`、`title`、`snippet`、`authority` 与实际存储 `scope`，精读使用 `kb get <id>`。
- `source_id` 表示消息、回执或文件证据。普通 Search 只返回来源摘要，审查和 Closeout 返回完整来源。
- `session_id` 表示工作上下文。它可以过滤 L1 Memory 和回溯证据，不作为正式 Wiki 条目的唯一身份。
- `authority` 区分 `binding`、`advisory` 和 `unverified_episodic`。检索内容作为工具数据或用户上下文进入宿主，不能覆盖宿主 system prompt。

多 Agent 适配采用无侵入流程。初始化阶段由宿主主动调用 `evolve search "<query>" --mode context`，加载适用约束、参考、情景记忆与代码入口；通过 `--from kb` 可只查询知识。执行阶段不读取宿主日志，不安装 Stop/Finish Hook，不改变宿主调用链。结束后优先通过已有 Session/Run 回执执行 `session review`、`kb candidates show` 和 `skill review`。不同 CLI 的原始历史只作为未来显式回溯源，由宿主类型与配置路径选择性读取，不进入初始化和常规检索流程。Search 不接收 ID，Get/Reference 使用稳定 ID。

## 4. 多层沉淀 Skill

### 触发与证据

Maestro Session 结束前固定本次可提取的证据范围和锚点，结束时使用同侧提交的完成回执记录这些引用。证据准备和提交路径只做确定性操作，模型提取在提交之后异步执行。现有 Maestro2 v3 完成事务写入文件型回执，完成后封存证据和候选侧写。Evolve 从已提交回执读取，并通过补扫恢复漏投事件。接入首版时，用完成回执携带证据引用并验证能回查，通过后再接入提取。 [Session 完成事务](/D:/maestro2/src/run/v3/mutation-engine.ts:1535) · [封存证据约束](/D:/maestro2/src/run/transcript-evidence.ts:201)

用 `maestro session evidence <descriptor.json> --session <id> --json` 固定经选择的会话片段。它返回引用，重复提交同一片段会复用已有快照。把引用作为 `--evidence` 附在相关 Run 的状态变更上，Session 完成时收集并检查这些引用。已完成的 Session 有新式回执时，沉淀和回溯都按该回执选择快照。回溯可以从同一证据定位 Run 及其 Skill 版本。

Session 自动沉淀由宿主配置启用。`MAESTRO_EVOLVE_CLI` 指向已安装的 Evolve JavaScript 入口，`MAESTRO_EVOLVE_PROJECT` 提供稳定项目 ID，`MAESTRO_EVOLVE_WIKI_ROOT` 可指定独立 Wiki 目录。完成事务把 Run 摘要及明确引用的会话快照锚点写入回执，后台进程按回执 ID 提取。模型失败或后台进程未启动时，可用 `evolve kb harvest scan <maestro-project> --project <id>` 补扫。用 `kb candidates show <receipt-id> --project <id>` 查看处理结果。

独立 Skill 通过执行入口明确记录 `succeeded`、`failed` 或 `cancelled`，生成包含执行 ID、实际 Skill 版本和证据引用的结束回执。两类回执进入同一沉淀入口。宿主 `Stop` 此时只作为会话监测信号。关联同一个 Skill 调用的 Session 回执和独立回执时，使用执行 ID 与证据锚点归并信号。沉淀和自进化 Skill 自身的执行事件排除在这一自动触发入口之外，避免递归触发。 [宿主 Stop 处理](/D:/maestro2/src/commands/hooks.ts:1360)

项目内的独立 Skill 可用 `maestro skills run <id> "<任务>" --json` 在 Codex 的只读模式下执行。入口固定 `skills/<id>/SKILL.md` 所在的 Git 提交和目录树，宿主按需打开包内 Markdown。配置 `MAESTRO_EVOLVE_CLI` 和 `MAESTRO_EVOLVE_PROJECT` 后，进程结束先用 `kb harvest skill --record-only` 提交回执，再异步调用 `kb harvest receipt <receipt-id>`。回执保存任务、输出、宿主终态和已读取的文档哈希。模型失败后可以凭同一个回执重试，或用 `kb harvest scan` 补处理。已有宿主回调仍可直接调用 `kb harvest skill <execution-id>`。已经归属 Maestro Session 的执行交给 Session 收尾。

| 层次 | 内容与去向 |
| --- | --- |
| 任务证据 | 用户纠正、报错、修复动作、验证结果、实际 Skill 版本。保留可定位的原始来源。 |
| 可复用知识 | 提取有适用条件与验证依据的经验，匹配同一项目 Wiki 中的已有条目。 |
| Skill 改进信号 | 只有证据能定位到某个版本的步骤缺漏、歧义或执行约束时，才交给自进化 Skill。 |

工具失败后恢复成功可以作为搜索线索。判定原因时需要把失败、介入动作和结果关联起来，并检查当时实际加载的 Skill。如果步骤已写明却被跳过，先查执行器和流程约束。项目特有的问题沉淀为项目经验。临时故障和根因待确认的问题留在任务证据中。提取器输出的来源引用必须归属于本次证据快照，可验证后才进入 Wiki 候选。

### 知识候选到 Skill 设计的路由

Closeout 候选先经过只读路由决策，再选择 Wiki、Skill 附加修正或元 Skill 设计。`evolve kb candidates route <closeout-id> <candidate-id>` 根据候选证据、目标 Skill、重复次数和结构条件返回路由结果。

| 条件 | 路由 |
| --- | --- |
| 项目级经验、术语、方法或可引用参考 | Wiki `reference` |
| 可归因到既有 Skill 的单条规则、条件链接或局部修正 | `workflow-evolve` 生成 `high/normal/low` 附加内容 |
| 需要新契约、新产物、跨 Skill 路由、至少 3 个稳定步骤或明确新增 Skill | 元 Skill 设计 |

元 Skill 路由会在当前项目 `.agent-memory/skill-design/tasks/` 生成设计任务。`skill design run` 通过显式元 Skill runner 生成设计回执，`skill design review` 校验候选能从目标 Skill 基线重建，`skill design replay` 复用既有双 Worktree 回放，`skill design apply|rollback` 复用现有版本应用链。这样知识沉淀可以形成可审查、可回放、可回滚的 Skill 改动，同时保持普通经验不被过度流程化。

### 更新决策

| 结果 | 首版行为 |
| --- | --- |
| 同一参考在相同条件下再次得到验证 | 自动给唯一匹配的 `active` 参考页追加经过校验的 `sources`，正文与作用域保持原值。 |
| 新参考，或已有参考的结论、步骤、适用条件需要变化 | 暂存候选，列出证据和差异，由统一更新入口确认并发布。 |
| 新增、修改、退役约束，或者参考升为约束 | 暂存候选，说明适用范围和影响，经明确确认后应用。 |
| 同义匹配不唯一、证据相反或范围重叠 | 保留现有生效条目，列出冲突双方及证据供审查。 |
| 证据不足或本次无可复用结果 | 记录本次处理完成与原因，允许产生零候选。 |

候选只携带操作、目标 ID、修改前版本、证据引用和变更内容。更新入口按 ID 定位页面，应用前比对基线内容哈希。文件变动后重新对照当前正文、证据和作用域。当前通用 ingest 按类型和标题决定路径，这个受控入口按稳定 ID 写页面，随后重建或刷新现有 Wiki 索引。 [通用 ingest 当前写入逻辑](/D:/evolve_workflow/src/wiki-ingest.ts:59)

用 `kb propose <change.json>` 暂存 `create`、`update`、`promote` 或 `retire`。项目证据用 `--evidence` 提供，沉淀证据通过 `--closeout` 与 `--candidate` 绑定。与现有条目发生重叠或冲突时，提案记录审核关系、理由和涉及的 ID。用 `kb changes --entry <id>` 核对修改前后内容及哈希，用 `kb apply <change-id>` 应用已确认的版本。退役条目保留原 ID，可继续查询历史。

完成回执和候选处理状态放在本地运行存储中，优先复用现有 SQLite 运行数据层，与可重建的 Wiki 索引分开。以来源项目加完成回执 ID 幂等消费，输出内容措辞的变化不影响处理身份。候选或零候选结果持久化后才确认本次处理。补证以规范化的证据引用去重，发布时保存更新基线与目标版本。文件写入后、运行回执确认前发生中断时，通过目标内容哈希复核已完成的写入，避免重复改动。Wiki 正文可从 Git 历史恢复，回滚后重新索引。

## 5. 自进化 Skill

### Memory 提供只读回溯工具

自进化 Skill 以项目根目录和 Session ID 调用 `evolve --root <project-root> session review <session-id>`。工具通过 Memory 模块的 Maestro 证据适配层，将已提交的 Run 状态、失败或阻塞原因、重试关系、完成摘要和经校验的会话片段整理成时间线。提取沿用 Memory L1 的消息格式、模型客户端和来源校验，使用专门的指令识别执行信号。独立调用用 `evolve --root <project-root> skill review <execution-id> --project <source-project-id>` 读取对应的结束回执，共用提取接口。两个入口都只返回结构化结果。Wiki 发布和 Skill 应用沿用各自的写入入口。 [回溯实现](/D:/evolve_workflow/src/retrospective.ts) · [Memory L1 接入](/D:/evolve_workflow/src/memory.ts:240)

新式完成回执把会话片段限定到其中列出的快照引用，包括显式空列表。缺少快照范围字段的旧 Session 按兼容路径读取其已经保存的快照。调用者需要补充上下文时，可显式传入经授权的 `--transcript <messages.json>`，消息保留单独的来源标识。有引用的快照缺失或校验失败时，回溯报告该证据错误。未固定到 Run 的片段可以用于定位问题，由调用者根据上下文核对关联。 [回执校验](/D:/evolve_workflow/src/closeout.ts:149) · [快照校验](/D:/evolve_workflow/src/transcript-evidence.ts:7)

### 初始化、Review 与自进化边界

初始化阶段只加载 L3 运行上下文。宿主调用 `evolve search "<goal>" --mode context --task <kind> --session <session-id>`，读取适用的 `constraint` 和 `reference`，并把返回的 `evolve-context/1.0` 作为工具结果或用户上下文交给当前 Agent。情景记忆默认参与召回，筛选特定历史 Session 时使用 `--memory-session <id>`。该步骤不读取 Codex、Agy 或 Claude 的历史文件。

当前实现没有按 CLI 自动发现历史目录的能力。`session review` 读取 Maestro Session/Run 回执和已提交的 `transcript-evidence`，`skill review` 读取独立 Skill 完成回执，`--transcript` 只接受用户或宿主显式授权的消息文件。Codex、Agy、Claude 的历史根目录和 JSONL 格式保留在后续回溯适配规范中，不进入初始化或常规搜索。

任务结束后，Maestro 已提交的 Session/Run 回执是 Review 和自进化的首选证据。`evolve session review <session-id>` 负责回溯执行信号，`evolve kb candidates show <receipt-id>` 负责审查候选，`evolve skill review <execution-id>` 负责归因到 Skill 版本。宿主只需要发起这些 CLI 调用，不需要安装 Hook 或改变模型调用。

不同 CLI 的历史文件属于可选回溯源。未来适配器按 `host_kind`、历史根目录和会话匹配规则读取 Codex、Agy 或 Claude 的历史，再将选中的片段转换为现有 `transcript-evidence/1.0`。适配器只在显式 Review 请求中运行，必须记录来源路径、会话 ID、片段 ID 和哈希。未配置路径或无法定位会话时，保持回执回溯结果，不阻塞 Review 和自进化。

| 返回字段 | 自进化 Skill 的用法 |
| --- | --- |
| `signals[].kind`、`summary` | 查看用户纠正、改变执行路径的错误、重试、中止、经验证的修复和可重复的流程问题。允许返回零信号。 |
| `signals[].sources`、`runIds` | 回查本次输入中存在的消息、快照或回执锚点。用回执中的关系串联失败、介入动作、重试和验证。没有 Run 关联的信号待核对。 |
| `runs[].skillRef`、`skillReads`、`knowledgeReads` | 按原提交、目录树与包路径检查入口和相关步骤。用封存回执中的 Markdown 路径、知识搜索、稳定 ID 和哈希确认实际读取情况。旧记录缺少这些字段时，将对应事实记为未知。独立调用的 `skill` 字段提供版本和终态。 |

### 自进化 Skill 核对归因

从候选信号定位到当时版本的具体步骤，确认缺漏、歧义或错误的默认条件是否解释了实际偏差。一个完成状态只能证明运行结束，改动效果需用可观察的验证结果确认。已有明确指令时，先用读取与执行证据排查宿主。临时故障留在任务证据中，跨 Skill 的项目约束与经验进入 Wiki。只有能指出目标 Skill、原版本、对应行为和证据锚点的信号进入草稿。

### 按优先级扩展 Skill

优先级决定内容何时进入执行上下文。自进化 Skill 根据适用范围和对结果正确性的影响建议优先级，评审时确认。

| 优先级 | 适用信号 | 放置和读取方式 |
| --- | --- | --- |
| 高 `high` | 已验证、适用于每次调用的正确性要求或关键门禁。 | 在原 `SKILL.md` 的 frontmatter 后附加一条短指令，每次执行前读取。 |
| 中 `normal` | 仅在可判断的场景中生效，命中时需要采用相应步骤。 | 在入口附加触发条件和相对 Markdown 链接。说明存放于包内 `references/learnings/`，满足条件时读取。 |
| 低 `low` | 可选技巧、排障案例或窄范围做法。 | 存入同一包内的参考目录。执行者主动查阅参考索引时读取，单篇文档的链接放在索引中。 |

用 `evolve skill draft` 生成附加文本或链接文档。草稿记录证据引用、目标路径、优先级与入口基线哈希。评审中优先级草稿时检查 `--when` 是否明确指出何时读链接，例如“目标环境为 staging 时”。已有指令或文档覆盖同一行为时，先复用现有内容或提出局部调整。补充内容与现行步骤冲突时，提出针对原步骤的修订并单独评审。 [自进化 Skill](/D:/evolve_workflow/skills/workflow-evolve/SKILL.md) · [草稿生成](/D:/evolve_workflow/src/skill-addition.ts:28)

第一条低优先级草稿在入口增加一个按需打开的参考索引链接。后续草稿在 `references/learnings/index.md` 增加对应文档的链接。旧的单文档草稿可在回放时补齐索引链。中、低优先级链接按场景打开。`required_links` 专用于每次执行都要读取的文件。宿主沿固定 Git 版本中的相对 Markdown 链接读取。 [宿主 Markdown 读取](/D:/evolve-maestro-runtime/src/skills/git-skill.ts:98)

### 回放、应用与回滚

`evolve skill replay` 在两个独立 Git worktree 上对同一任务输入调用同一宿主脚本。场景覆盖旧版问题和已有成功流程。回执记录两版加载的文件与哈希。高优先级验证入口短指令改变目标行为。中优先级验证触发场景加载正确字节并执行对应步骤，非触发场景沿用原有路径。低优先级核对常规场景的读取清单与原路径一致，并验证主动查阅时能沿索引读取目标文档。

确认采用后，`evolve skill apply` 对比当前提交、Skill 工作树和回执，再快进到已验证的候选。重新调用确认宿主加载新版。应用关联证据、回放结果与新旧版本。紧接该候选的回滚由 `evolve skill rollback` 创建 Git 反向提交。后续提交已经改变历史时，重新核对影响后再恢复。

首版用本地项目 Skill 和真实宿主验证路径装载，候选装载实验限定在验证执行中。Wiki 继续承载跨任务约束与经验，Skill 中通过稳定 ID 引用相关知识。只有适合固化在执行步骤中的改动进入 Skill 文件。

## 6. 旧 Spec 和 Knowhow 迁移

### 两遍导入

第一遍解析固定的 Maestro2 来源快照。旧 Spec 用原解析语义拆成独立条目，以 `constraint` 导入，覆盖可识别的 `<spec-entry>` 和旧标题条目。旧 Knowhow 沿用一份内容为一条的粒度，以 `reference` 导入。正文原样保留，旧 `recipe`、`tip` 等子类型可保留为标签。 [旧 Spec 解析](/D:/maestro2/src/tools/spec-entry-parser.ts:123) · [旧 Knowhow 存储](/D:/maestro2/src/tools/store-knowhow.ts)

有原 ID 的条目用来源项目与旧 ID 建立映射。无 `sid` 的条目用来源项目、原文件和可区分的条目锚点生成确定性 ID，并在迁移映射中固化。重复迁移按映射定位同一条目，发现目标已经修改时交给审查。迁移输入使用普通解析与确定性映射，保留来源与原文。

第二遍解析旧引用、生命周期、适用范围和替代关系。保留旧别名，已有替代关系映射到新 ID，退役条目仍可按 ID 查历史。旧类别、关键词和仓库条件按原读取语义映射。遇到 ID 冲突、作用域未知、旧约束互相冲突或引用断链时，保留原类型与证据并标记 `needs_review`，明确受影响的切换范围。疑似重复条目进入核对列表，正文逐条迁移。

导入也覆盖旧加载器可直接读到的无结构规则文件。带 `ref` 的旧 Spec 导入为参考条目，保留 `spec` 旧 ID，并链接到目标 Knowhow。迁移预览列出缺失引用和待核对的作用域。用隔离 Wiki 验证了 Maestro2 项目基线的 74 个稳定 ID、43 条活跃约束和 4 条索引链接。七类项目级查询逐条核对旧加载器返回的正文，`arch` 对应 17 条，`coding` 对应 13 条，`ui` 对应 4 条。结果以迁入且仍活跃的约束为范围。旧加载结果中的一条冲突约束在 Wiki 中待审查。 [迁移实现](/D:/evolve_workflow/src/wiki-migration.ts)

### 切换

选一组项目基线任务，将原入口和新入口的约束集合逐条比对，覆盖项目全局、局部适用、已退役和冲突条目。完成迁移核对的范围切到新 Wiki 读取与更新，旧文件保留为可回查档案。受影响的范围在依赖核对完成前沿用旧入口。切换前保留来源快照和 ID 映射，便于查回旧条目或回退读取入口。

新 Run 复用 `workspaces.linked` 的 `share: [spec]` 权限。已迁移的共享源从该仓库自己的 `wiki/entries/` 读取，规则按消费方 UUID 筛选。快照用 `source_repository` 记录来源别名和可取得的 UUID。撤销共享影响后续分派，已启动的 Run 沿用原快照。验收覆盖缓存身份失效、仅分享 Knowhow、跨仓库适用范围和撤销后的恢复。 [共享约束装载](/D:/evolve-maestro-runtime/src/run/v3/evolve-closeout.ts)

共享参考复用 `share: [knowhow]`，每次搜索和打开都检查当前授权。检索在已过滤的 Markdown 上复用 MemoryKnowledge 全文检索和图谱遍历，免去共享库索引过期带来的范围误判。撤销共享后，搜索结果与原仓库引用随即失效。旧 Knowhow 文件在导入前沿用旧检索入口。 [双 CLI 共享验收](/D:/evolve_workflow/test/maestro-closeout.mjs)

用 `evolve kb import <source> --root <project> --project <id> --scope project|global` 预览迁移，确认后加 `--apply`。全局层的 `<source>` 为 `MAESTRO_HOME`，团队与个人层为 Maestro 项目根目录，团队与个人旧目录可作为显式 `<source>` 导入目标项目。各目录沿用同一 Wiki 格式。

| 层 | 旧规则目录 | Wiki 条目目录 |
| --- | --- | --- |
| 全局 `global` | `MAESTRO_HOME/specs/` | `MAESTRO_HOME/wiki/entries/` |
| 团队 `team` | `.workflow/collab/specs/` | `.workflow/collab/wiki/entries/` |
| 个人 `personal` | `.workflow/collab/specs/<uid>/` | `.workflow/collab/personal/<uid>/wiki/entries/` |

新 Run 按全局、共享仓库、项目、团队、个人的顺序合并约束。团队与个人沿用本地 Git 邮箱对应的成员记录。个人层只读取该成员的目录，快照记录层和 UID。仍有适用旧约束且对应层尚未导入时，分派沿用旧读取路径。旧脚手架的示例和空种子无需切换。已完成的 Run 使用分派时的快照。 [新旧分层验收](/D:/evolve_workflow/test/maestro-closeout.mjs)

`evolve kb list --kind constraint` 支持 `--keyword`、`--task` 和 `--path`。已导入的结构化条目继续使用原关键词，旧 Wiki 页面可从保存的迁移属性读取。运行中的查询只读取该 Run 固定的约束及其关键词。 [新旧读取验收](/D:/evolve_workflow/test/maestro-closeout.mjs)

## 7. 迁移顺序与验收

| 阶段 | 工作 | 通过条件 |
| --- | --- | --- |
| 1. 固定基线并试迁 `analyze` | 按下文试迁任务接入可信绑定、契约快照和 Markdown 链接。其他步骤沿用兼容路径。 | 新旧入口的参数、产物和门禁行为一致。启动包仅含引用与运行元数据。旧 Run 可恢复，缺失版本可定位。 |
| 2. 合并编排入口 | 在样本路径上收敛 Next 的路由、Maestro 的规划、Ralph 的循环，保留旧调用兼容入口。 | 规划、执行和恢复只绑定一条 Session。旧 Next 的建议分支无执行副作用。手动与自动使用同一链，风险升级时保留确认。 |
| 3. 统一 Wiki 与样本迁移 | 增加条目读取、作用域匹配、历史查询和旧 ID 解析。迁移一组有关联的 Spec 与 Knowhow。 | 原文、来源和旧引用可回查。迁移重跑命中原 ID。同一任务前后加载相同的有效约束。重建索引后解析结果一致。 |
| 4. 收尾沉淀与发布 | 接入 Session 完成回执和独立 Skill 结束回执。实现证据校验、匹配、补证与候选发布。 | 重复投递、漏投补扫和中途重试都只产生一批结果。零候选正常完成。相反证据生成冲突候选。约束与候选发布可追溯。 |
| 5. 自进化闭环 | 封装 Memory 回溯接口。选一个项目 Skill，从结束回执提取信号、核对归因、分级生成附加内容，经真实宿主回放后应用并回滚。 | 信号可回查到原证据和 Skill 版本，缺少关键证据时保留待确认。旧版能复现问题，候选改善目标行为，原有成功场景通过。实际加载路径和哈希与候选一致，应用能拒绝基线漂移，回滚可复查。 |
| 6. 扩大迁移范围 | 迁移元 Skill、Odyssey、Swarm 和其他步骤。按仓库或 Skill 比对旧规则，逐组切换。 | 宿主安装后可以从包内读取所需流程。Odyssey 可恢复原模式，Swarm 的角色及产物契约不变。新 Wiki 接管确认范围，旧运行记录走兼容读取。 |

用 `evolve skill install ew-odyssey ew-swarm` 安装长期流程与协作 Skill。提交到 Git 后，七个 `ew-odyssey-<mode>` 命令绑定同一个包，再选择各自的契约和必读文件。Swarm 从绑定提交读取角色、控制器和模板。旧 Run 按原绑定恢复。 [Odyssey 入口](/D:/evolve_workflow/skills/ew-odyssey/SKILL.md) · [Swarm 协议](/D:/evolve_workflow/skills/ew-swarm/specs/swarm-protocol.md)

安装包验收已覆盖七种 Odyssey 模式和 Swarm 的项目导入、分派和恢复。契约测试逐项比对八个命令的旧版与新绑定哈希。 [安装包验收](/D:/evolve-maestro-runtime/scripts/check-session-run-packaged-install.mjs) · [契约测试](/D:/evolve-maestro-runtime/src/run/contract.test.ts)

`npm run test:codex-campaigns` 用真实 Codex 验证 Odyssey Review 在 Git 版本变化后恢复原模式和文档，完成四维审查并封存 `review-session`。Security 样本完成 OWASP 十类和依赖锁文件的 quick 只读审计，Defensive 样本完成 8 类模式、局部切片、传播、Q4 与风险评分。Swarm 样本执行两轮。每轮由 Codex 协调宿主通过 `team_agent` 分派两个 ant 和独立的 scorer 进程。worker 按 Run 绑定读取原版角色文档，写入产物并回报。协调端重连后核对成员、任务、已确认消息与原分派，Python 控制器提交并重放同一轮的评分更新。analyst 从 MCP 恢复状态和消息。验收程序驱动 Python、analyst 和封存。 [真实宿主验收](/D:/evolve_workflow/test/codex-campaigns.mjs) · [Swarm MCP 协调说明](/D:/evolve_workflow/skills/ew-swarm/references/mcp-coordination.md)

Swarm 在分派前保存每轮的 assignment 批次，恢复时沿用原起点和 ant ID。LLM 模式要求评分覆盖同一轮的全部已接受 ant 产物。scorer 失败时，协调端可显式选择整轮 fallback。控制器回执保存评分方式，重放会检查分派、产物和评分输入。 [控制器回归](/D:/evolve-maestro-runtime/.claude/skills/team-swarm/scripts/test_aco.py)

单独运行 `npm run test:codex-campaigns -- debug` 可验收 Odyssey Debug。Codex 通过本地测试 MCP 读取 Git 历史、验证失败复现并提出根因。在指导文件改版后，新的 Codex 进程从原绑定和 `S_FIX` 检查点读取上下文，通过固定文件的 MCP 工具提交修复。另一个进程读取真实 diff 并执行补充用例，最后由验收程序封存会话、追加式证据、探索结果和诊断报告。 [Debug 验收](/D:/evolve_workflow/test/codex-campaigns.mjs) · [产物元数据](/D:/evolve-maestro-runtime/.claude/skills/maestro-odyssey/references/prepare/odyssey-debug.md:103)

统一 Maestro 入口以 Skill 包分发，入口按需链接意图分类、建链、Run 循环、自动执行和目标修订。Next 与 Ralph 的兼容入口委托该包。已有 Run 可通过旧解析入口读取迁移后的准备说明和分类目录。安装包同时分发元 Skill 及其契约和回放说明。 [统一 Maestro Skill](/D:/evolve-maestro-runtime/.claude/skills/maestro/SKILL.md) · [安装包验收](/D:/evolve-maestro-runtime/scripts/check-session-run-packaged-install.mjs)

`analyze`、`plan` 和 `execute` 的准备说明与流程已归入 Maestro 的 `steps/`，三步沿用原契约哈希。`brainstorm` 和 `review` 使用同一主包的步骤契约与链接。项目提交 `skills/ew-orchestrate/` 后，由 Maestro 主入口解析这些步骤，旧 Run 用恢复包中的 `guidance_files` 查找兼容文件。 [Analyze Step](/D:/evolve_workflow/skills/ew-orchestrate/steps/ew-analyze/SKILL.md) · [Plan Step](/D:/evolve_workflow/skills/ew-orchestrate/steps/ew-plan/SKILL.md) · [Execute Step](/D:/evolve_workflow/skills/ew-orchestrate/steps/ew-execute/SKILL.md)

常规 `run create` 在分派时按绑定契约的 `consumes` 别名接收同一 Session 的封存产物，核对发布回执、类型、角色、schema 和字节摘要。`upstream_aliases` 将别名映射到 `upstream` 中的 Artifact ID，路径相对于 Session 目录。恢复时沿用原映射，封存时从 `input_refs` 记录产物来源。缺失的可选槽位由 Skill 自身处理。安装包样本用三次 `run create` 验证 `current-analysis` 和 `current-plan` 自动交接，同时覆盖篡改拒绝、请求重放、`plan --tdd` 引用、旧 `plan` Run 恢复和 `execute` 产物兼容性检查。 [安装包验收](/D:/evolve-maestro-runtime/scripts/check-session-run-packaged-install.mjs)

### 7.1 `analyze` 试迁任务（已完成实现）

试迁只对明确启用的 `analyze` / `maestro-analyze` 生效。两种命令名映射到同一个 Skill，原入口继续可用。先记录旧行为并完成新路径的端到端验收，再进入阶段 2 的编排入口合并。

试迁用 `MAESTRO_ANALYZE_SKILL=1` 启用。后续可通过 `MAESTRO_PROJECT_SKILLS` 指定以逗号分隔的项目 Skill ID。步骤发现和 Run 分派都从项目当前 Git 提交解析 `skills/<id>/SKILL.md`。停用配置只影响新分派，已绑定的 Run 继续读取原提交。

| 任务 | 工作和交付 | 依赖 |
| --- | --- | --- |
| **A1 固定基线** | 固定一份 Maestro2 来源版本，给完整分析、`-q`、`--gaps [ISS-ID]`、`--from <artifact-alias>` 及数字和文本主题留出对照样本。记录位置参数、门禁适用条件、产物和后续 `plan` 交接。必需产物是 `outputs/findings.json`，别名为 `current-analysis`。`risk-matrix.json` 和 `priors.json` 按现有契约可选。用测试区分现有 Runtime 真正执行的校验和流程要求执行端检查的步骤门禁。 | 无 |
| **A2 整理 Skill 包** | 在 `skills/ew-orchestrate/steps/ew-analyze/` 建立 `SKILL.md`，将 `prepare/analyze.md` 的参数声明和 `contract` 迁入 frontmatter，准备说明放入 `references/prepare.md`，`workflows/analyze.md` 放入 `references/workflow.md`。按触发条件链接边界评审、Issue 根因分析和收尾说明。保留完整分析及 `-q`、`--gaps` 的条件分支和检查项，共享收尾说明引用同一份固定版本。 | A1 |
| **A3 绑定版本与读取 Markdown** | 在协调端用同一解析入口完成步骤发现与调度。定位 `analyze` 包，从固定 Git 对象读取入口 frontmatter，生成规范化契约快照与可信绑定。宿主读取器按下文规则打开链接，记录实际读取的文件与版本。试迁只选择一个实际宿主和一个受 Git 管理的项目。 | A1、A2 |
| **A4 切换 Session/Run 调用点** | 在新 `analyze` Run 创建时原子持久化绑定、契约快照和摘要。启动、恢复、检查及封存按下表改读已绑定信息。运行时仍复用状态机、产物校验、权限校验和回执。 | A3 |
| **A5 接通旧 Run 和失败恢复** | 用持久化绑定区分新旧协议，验证旧运行中和已封存样本、同请求重放、缺失原版本以及显式改版重试。保留旧目录和兼容解析器，允许对新分派关闭试迁。 | A4 |
| **A6 验收并清理试迁入口** | 按第 7.4 节跑真实宿主、构建后 CLI 和安装包验收。确认新路径已经切断旧指导读取，移除试迁中的重复解析调用，保留历史兼容入口。 | A5 |

A1 的对照以现有 `contract_version: 2.1` 和流程分支为准。`--from` 仍走现有产物解析和校验。Session 目标与 Run 的位置参数各有来源，产物输入继续使用已封存的同 Session Artifact 引用。A1–A6 已落地：`skills/ew-orchestrate/steps/ew-analyze/` 提供入口、准备说明、工作流和条件引用，绑定在创建事务中固定 Skill 提交、目录树和契约，`run read skill` 记录入口与 Markdown 链接的字节证据，旧 Run 继续沿兼容分支恢复。安装包验收覆盖 `analyze → plan → execute`、重放、旧 Run 恢复、产物交接和绑定失效。 [现有 `analyze` 契约](/D:/maestro2/prepare/analyze.md:4) · [现有分支和门禁](/D:/maestro2/workflows/analyze.md:36) · [Maestro Analyze Step](/D:/evolve_workflow/skills/ew-orchestrate/steps/ew-analyze/SKILL.md) · [安装包验收](/D:/evolve-maestro-runtime/scripts/check-session-run-packaged-install.mjs:245)

### 7.2 要移除的 Session/Run 读取

| 调用面 | 新 `analyze` 路径 | 兼容与校验 |
| --- | --- | --- |
| 步骤发现、`session chain`、`run create` / `run create` | 两个入口共用可信绑定。新 Run 采用绑定的契约摘要。`createRunningRunV3` 及 `republishedConsumerInputs` 使用快照内的消费者槽位，避免再次从命令名解析 `prepare` / Skill。 | 保留前驱门禁、产物资格、修订号与请求回执校验。首次分派确定绑定，重放已有请求用原 Run。 |
| `v3BirthPacket`、`run get`、`session resume-view` | 启动和恢复从记录返回 `skill_ref` 与契约标识。新包跳过 `buildV3GuidanceSnapshot` 和 `resolveStepContent`。`goal_mode` 如仍需交给宿主，在绑定时作为元数据提取。`resume-view` 继续投影原运行索引。 | 旧 Run 的 `guidance` 兼容输出留在旧分支。`brief` 和 `resume-view` 继续只读。 |
| `run check` | 从 Run 读取已绑定契约并核对执行端的读取证据，去掉按命令名找当前契约和读取 workflow `finish:` 的逻辑。文字检查项由宿主随流程文档读取。 | 产物 schema、必要产物、报告摘要、状态和修订校验沿用现有实现。试迁前后核对 CLI 门禁结果。 |
| `run complete --advance`、恢复封存、产物兼容性 | `assertRunContractSnapshot` 校验持久化契约摘要与绑定。`prepareArtifactPublication` 用相同快照校验输出。旧恢复封存仅留给历史路径。面向新 `analyze` 的兼容性检查如需要读消费者契约，使用该消费者的可信绑定。 | 保留封存、注册产物别名、记录产物来源和推进步骤的原子语义。新 Run 改版通过显式重试生成新绑定，旧 `run rebind` 逻辑留给旧路径。 |

`session complete` 继续使用 Session、Run 和决策状态，也继续给沉淀流程提供完成回执。`resolveCommandSource`、`resolveStepContent`、旧步骤枚举和旧目录在其他步骤及历史数据仍使用时继续存在。 [启动与产物输入](/D:/maestro2/src/run/v3/mutation-engine.ts:967) · [恢复包](/D:/maestro2/src/commands/run-v3.ts:376) · [检查与完成清单](/D:/maestro2/src/commands/run-v3.ts:503) · [封存产物](/D:/maestro2/src/run/v3/mutation-engine.ts:437) · [消费者契约](/D:/maestro2/src/run/artifact-compatibility.ts:238)

### 7.3 Markdown 解析与旧 Run 兼容

**Markdown 链接解析。** 从协调端已绑定的 `SKILL.md` 启动。流程中以链接所在文件的目录解析标准相对链接，例如 `[流程](references/workflow.md)` 或 `[输出检查](workflow.md#输出检查)`。路径使用 `/`，按标准 Markdown 链接解析后进行规范化，`#` 后的部分只定位同一版本文件的章节。每次读取检查目标是固定 Git 树中的常规文件，规范化后仍在当前 Skill 包内，或命中绑定时明确列出的共享文件。绝对路径、外部 URL、越界路径、符号链接与缺失文件不能作为执行引用。普通说明链接继续供阅读。只在执行到对应分支时读取其流程链接，引用环和必要章节缺失报告明确错误。记录来源文件、目标路径、目录树 ID 和实际 blob ID。

**绑定和失效处理。** 可信绑定从授权项目的固定 Git 提交生成，包含 Skill ID、仓库、提交、包根、入口路径、目录树 ID 和冻结契约摘要。`skill_ref` 可放入响应，绑定及契约随 Run 在原事务中持久化。Run 使用协调端登记的绑定，普通请求和工作者无法提交一份替代契约。必需链接缺失或内容不属于绑定版本时，定位失败的步骤、引用和版本，恢复可读取的原版本后继续。运行过程中的工作树改动由新提交和新绑定生效。

`SKILL.md` 的 `required_links` 声明每次执行都要打开的入口链接。执行器用 `run read skill` 读取入口和适用的后续链接，Store 将来源、目标、Git blob ID 和字节哈希记录到该 Run 的读取证据。检查和成功封存会按原 Git 树重验这份证据，封存回执保留已核对的记录。条件链接仍按 Skill 的分支说明读取。

| Run 场景 | 恢复行为 |
| --- | --- |
| 旧 v3 Run 无新绑定 | 使用旧解析入口和已有 `command_contract_hash` 检查。旧指导包与旧运行契约继续可读。缺档时给出旧来源与恢复路径。 |
| 旧 v1/v2 历史 Run | 沿用现有历史读取和旧协议迁移分支，本次保留其原始记录。 |
| 新 Run 有有效绑定 | 恢复同一 Run，用原版本读流程，并用原快照完成检查和封存。读取证据缺失时重新读取并补齐证据。 |
| 新 Run 的绑定损坏或原包不可取 | 明确阻断继续执行，优先恢复原包。需要新版时走显式取消或重试并分配新 Run。绑定异常不得触发旧解析回退。 |
| 重放已经提交的创建请求 | 返回原回执、Run ID、原绑定和原修订号；即使当前默认 Skill 版本已变化或原包暂不可取，也能查原回执。真正恢复仍需取到原包。 |

试迁回退只影响之后的新分派。已创建的绑定 Run 保留新读取路径直到收尾，旧 Run 继续走兼容分支。删除旧目录前需要确认其余步骤、旧项目覆盖、安装包和需恢复的历史 Run 均有可用入口。

启用试迁前要核对 Run Store、CLI JSON 消费端和所选宿主对新增绑定字段的支持。当前协议含严格校验，试迁应先让新读端兼容缺少绑定的旧记录，再让支持该能力的入口写入绑定记录。回退时保留能读取两类记录的版本。

### 7.4 `analyze` 验收矩阵

| 场景 | 可观察结果 |
| --- | --- |
| 旧行为对照 | 完整分析与精简、缺口、原产物输入分支保持现有参数与门禁条件。`findings.json` 缺失或 schema 错误时拒绝封存。`plan` 可读取 `current-analysis` 的原 Artifact 别名。 |
| 新路径不读取旧指导 | 新 `analyze` 的启动、`brief`、`check`、`complete` 跑通。响应携带引用与契约标识。用读取监测或移除试验环境中的旧指导文件证明没有访问旧 `prepare` / `workflows`，同时验证缺少旧文件的历史 Run 有相应恢复提示。 |
| 只改被链接文件后恢复 | 提交 A 后启动 Run，仅改 `references/workflow.md` 中可观察的步骤并提交 B。恢复旧 Run，核对读取记录中的 A 版 blob ID 和旧版结果。新 Run 显式绑定 B 后核对新版 blob ID 和结果。 |
| 断链与伪造 | 覆盖缺失包、断链、路径越界、伪造执行读取证据或放宽契约。任务报告中的链接无法更改步骤链或门禁。受影响 Run 给出可定位错误，保持旧产物封存状态。 |
| 幂等与兼容 | 同请求重复启动只返回原 Run。恢复旧运行中 Run 与读取已封存 Run 均保留原 ID、回执和 Artifact 关系。关闭试迁后新分派可走旧入口，已绑定 Run 仍可完成。 |
| 实际交付 | 在真实宿主完成 `analyze → plan` 小样本，在构建后的 CLI 跑状态与回执测试，并在独立安装目录验证 Skill 相对链接可解析。复用现有 `check:session-run-contract-parity`、`check:session-run-release-machine` 和 `check:session-run-packaged-install` 作为回归入口。 |

用 `npm run test:codex-workflow` 验证三套编排 Skill。Maestro 用真实 Codex 串联分析、计划、执行和审查，提交协调器根据 Codex 输出写入修改并执行 Node 验收。Odyssey 完成一次只读审计，经协调器决策后封存。Swarm 用两个 Codex 工作者和一个独立评分者完成一轮 Python ACO。三套测试都验证固定版本的 Skill 读取、Agent Memory 精确读取和 Session 完成，并检测是否调用了旧 CLI。也可分别运行 `npm run test:codex-chain` 和 `npm run test:codex-campaigns`。Git 改版后的原 Run 恢复由 `npm test` 覆盖。

### 7.5 知识闭环的端到端验收

用 `npm run test:codex-replay` 验证真实 Codex 与 Agent Memory 的 Skill 回放、应用与回滚，核对 Git 提交中的文档哈希、新增链接的读取条件和 Memory 检索回执。已有 Maestro Session 回执的兼容验收使用 `npm run test:legacy-closeout`，通过 `MAESTRO_REPLAY_CLI` 指定生成旧回执的历史运行时。测试覆盖会话纠正、Run 重试、重复投递、Wiki 发布、索引重建及临时网络故障。

用 `npm run test:legacy-codex-standalone` 回归历史宿主的独立 Skill 结束回调。测试让真实 Codex 读取提交中的 Markdown，再用本地模型测试端点检查收尾取证和回执重试。测试也覆盖宿主失败产生零候选，以及已有 Session 归属的调用退出独立入口。

端到端验收使用一个有实际用户纠正的场景。例如数据库迁移预检 Skill 漏传 `--dry-run`，补参后验证通过。结束回执触发沉淀，重复投递只处理一次。发布后，新 Session 能检索相关参考，并按原作用域加载迁移来的约束。自进化 Skill 生成补丁，旧版复现漏参，候选版首条命令即带齐参数，已有的成功用例继续通过。应用后重新调用，核对宿主加载新版，再验证回滚。

验收同时覆盖一个反例。临时网络故障经重试恢复时，任务证据留档，Wiki 无新增约束，Skill 无补丁候选。删除可重建的 Wiki 索引再重建，条目、别名、链接、约束加载以及沉淀进度的查询结果应一致。

真实 Codex 回放已覆盖三级。高优先级读取入口后执行短指令。中优先级只在触发场景读取新增说明。低优先级在常规场景只读取入口，在显式查阅场景沿固定版本的参考索引打开新文档。回放核对文件路径与哈希，并覆盖旧的单文档草稿。独立 Skill 验收还用失败调用的执行 ID 取回终态、版本与信号来源。

用 `npm run test:codex-evolve` 在隔离仓库验证 Codex 执行、Agent Memory 检索、历史证据、Agy 讨论和确认以及应用后复验。`npm run test:legacy-codex-evolve` 覆盖旧 Session 回执中的可复用信号和临时故障。 [自动迭代验收](/D:/evolve_workflow/test/codex-evolve-native.mjs) · [Session 收尾验收](/D:/evolve_workflow/test/maestro-closeout.mjs) · [草稿回放](/D:/evolve_workflow/test/codex-replay.mjs)
