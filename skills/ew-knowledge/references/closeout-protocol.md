# 收尾与候选晋升协议

本文件定义任务 / Session 结束或独立知识收尾时，完成责任人（Completion Owner）遵循的规范流程：`Read → Refresh → Present → Ask → Execute → Verify`。

## 所有权与时机

- Run 完成阶段仅允许沉淀候选；已采纳决策或锁定约束不等同于 Wiki 发布授权。
- 长链中间 Run 继续推进既有链，不在中途插入发布审批；整体终端收尾或显式知识管理请求时执行本协议。
- `ew-knowledge` 自身与 `workflow-evolve` 的执行记录不进入自动沉淀，防止递归。

## 执行步骤

### 1. Read internally（只读收集与查重）

先消费已提交回执并查看现有候选与对照关系，不把人类用户直接打发去运行 CLI：

```text
evolve kb harvest session --root <project> <session-id> --project <source-project-id> --receipt <receipt-id>
evolve kb harvest skill --root <project> <execution-id> --skill <skill-id> --skill-version <version> --status <status> --transcript <messages.json> [--knowledge-receipt <knowledge-reads.json>] [--session <session-id>] [--record-only] --project <source-project-id>
evolve kb harvest receipt --root <project> <receipt-id> --project <source-project-id>   # 模型抽取失败或 --record-only 后沿用同一回执重试
evolve kb harvest scan --root <project> <source-project-root> --project <source-project-id>
evolve kb candidates show --root <project> <receipt-id> --project <source-project-id>
```

- 重复投递按回执身份幂等处理；模型抽取失败时沿用同一回执运行 `kb harvest receipt <receipt-id> --project <source-project-id>`（Session 回执则用相同 `--receipt` 重跑 `kb harvest session`），不重构或扩大证据范围。若候选与唯一活跃、未锁定的 project `reference` 正文完全一致，收尾会经 `propose`/`apply` 自动合并 `sources` 并在 `wiki_changes` 留存审计记录，其余候选保留待审。
- 先用 `evolve kb search` / `evolve kb get <id|q-N:idx>...`（支持短前缀与批量读取）核对每条候选与现有活跃 Wiki 的重复、重叠或冲突，保留双方证据；`propose` / `apply` 必须使用 `kb get` 返回的规范完整条目 ID。可在授权前用 `evolve kb propose` 生成待审变更预览（`kb propose` 仅写入 `<root>/.evolve/closeout.db` 暂存区，不修改 `wiki/entries/`；真正修改 `wiki/` 需在授权后执行 `kb apply` 或 `kb candidates publish`）：

```text
evolve kb --root <project> propose <change.json> --closeout <closeout-id> --candidate <candidate-id>
evolve kb --root <project> propose <change.json> --evidence <receipt-id>
evolve kb --root <project> changes [<change-id>]
```

- 没有合格候选时直接记录零候选回执并正常结束。
- **日期 / commit SHA 锚点与被拒绝方案检查**：涉及代码实现或架构决策的候选必须附带回执/Git `HEAD` 日期与 `<repo>@<sha>` 锚点；若候选属于被拒绝的功能或设计方案（`.out-of-scope/` 概念级记录），先按概念相似度检索已有 Wiki（并将仓库现存 `.out-of-scope/*.md` 仅作只读参考），确认为持久性架构/范围拒绝而非“已实现功能”或临时延期后，再通过 `kb propose` → `kb apply`（或首次全新 `reference` 授权发布）纳入受治理 Wiki，禁止绕过 `evolve kb` 直写文件。

### 2. Present（结构化呈现）

向用户逐条展示每个可处理候选的：
- 精确 `candidate-id`、建议动作（新增 / 更新 / 追加来源 / 标记冲突或取代 `superseded` / 跳过）与理由；
- 真实验证证据锚点（完成回执、消息 ID、命令结果，以及代码类断言对应的日期与 commit SHA）；
- 与既有 Wiki 条目（含概念级被拒绝方案）的命中对照关系（不要将不可信原始对话摘录直接当作已验证正文）。

### 3. Ask（人类审查与固定授权）

通过宿主提供的结构化用户提问能力一次性收集**固定候选 ID 列表、关系裁决与发布/分流动作**的明确授权：
- 必须提供选择、拒绝与延期选项；群组确认仅对本次展示的固定 ID 列表生效。
- `-y`、高重要性标记或机器建议**不能**替代人类发布确认；无提问工具且无先前针对同批固定 ID 的显式授权时，直接延期保留待审查清单，不要输出裸命令敷衍了事。
- 不得为清空待办而伪造 `duplicate` 等裁决。

### 4. Execute（按固定授权逐项执行）

仅对明确批准的固定 ID 执行对应操作（禁止 `--all` 扩大选择范围）：

```text
# 路径 A：对审核通过的变更执行 Wiki 应用或直接发布
evolve kb --root <project> apply <change-id>
# kb candidates publish 仅适用于创建无 matched_entry 与 related_entries 的全新 mode: reference 条目；
# 创建 constraint、存在关联条目或执行 update/promote/retire 时，必须走 kb propose → kb apply
evolve kb candidates publish --root <project> <closeout-id> <candidate-id> "<title>" [--entry entries/<slug>]

# 路径 B：问题可归因于具体 Skill 或需要新流程包时按序分流
# 1) 先用 kb candidates route 判定路线（wiki | skill-addition | skill-design）
evolve kb candidates route --root <project> <closeout-id> <candidate-id> --skill <skill-id> [--skill-version <version>]
# 2) 可按来源补采信号（Session 用 session review；独立 Skill 用 skill review）
evolve --root <project> session review <session-id>
evolve --root <project> skill review <execution-id> --project <source-project-id>
```

根据 `kb candidates route` 返回的 `route` 执行交接：
- **`skill-design`**（满足 [knowledge-route.md](knowledge-route.md) 规则 8 结构化条件）：`kb candidates route` 同时创建 `design_task`。直接或自动路由转交 `ew-skill-design`，按 `evolve skill design task <task-id>` → `run <task-id> --runner <script>` → `review <design-id>` → `replay <design-id> --runner <script> --scenarios <json>` 执行；通过明确确认门禁后再运行 `evolve skill design apply <design-id>`，失败时用 `evolve skill design rollback <design-id>` 回滚。
- **`skill-addition`**：转交 `workflow-evolve`（可运行 `skills/workflow-evolve/scripts/evolve-loop.mjs`），从 `evolve kb candidates show <receipt-id> --project <source-project-id>` 与原候选构造参数：
  - 目标入口：`--skill skills/<skill-id>/SKILL.md`（若安装在宿主目录则为 `<skill-root>/<skill-id>/SKILL.md`，需先对齐已提交版本）。
  - 归因证据来源（三选一）：Session 来源传 `--session <session_id>`；独立 Skill 来源传 `--execution <execution_id> --project <source-project-id>`（`<execution_id>` 取自 `kb candidates show` 的 `session_id` / 执行 ID）；或传归一化 `--history <transcript-evidence/1.0 JSON>`。
  - `--scenarios <scenarios.json>` 构造要求：JSON 数组至少含 2 条场景——至少 1 条 `"baseline": false`（基于 `candidate.content` 与 `candidate.sources` 复现当前 Skill 失效行为并给出期望输出）与至少 1 条 `"baseline": true`（验证既有正常路径保持通过）。

### 5. Verify（回读确认）

执行后回读 `evolve kb get <id>` / `evolve kb changes <change-id>` / `evolve kb candidates show <receipt-id>`，如实报告成功发布的条目 ID 与仍处于待审查/延期/阻塞状态的候选项。

## 个人跨项目经验审阅

`evolve experience pending` 读取配置允许的已完成项目，按封存证据列出本地候选；不上传内容、不另调模型。候选提炼与正式 Wiki 发布、项目完成互不阻塞。

用 `evolve experience review <候选ID>` 查看精确待发正文、目标账号、同栈可能相关项、建议关系和审批哈希。任何正文或验证摘要含有内部信息时暂缓，不应发布。相同经验仅补验证来源；发现冲突先展示双方，不覆盖旧条目。人工裁决重复或冲突时，用 `--relation duplicate|conflict --related <条目ID>` 重新预览。相似候选列表不是完整的冲突证明。

按本协议一次获取固定条目及动作的授权；拒绝或延期不执行写入。批准后由操作者在 CLI 运行 `evolve experience publish <候选ID> --relation <已确认关系> --approval <该预览的哈希>`，如预览指定过 `--related`，发布时带上相同 ID。候选、目的地或参考版本变化须重新预览和确认；`-y` 不是授权。发布回读成功后保留本地回执。服务返回失败或结果未知时，不自动重发，先重新预览并核对远端状态。
