# Planning & Chain Creation

本文件定义意图分类（`S_CLASSIFY`）、建链（`S_CREATE`）与分解（`S_DECOMPOSE`）协议。完整步骤路由与前置阈值见 [意图分类目录](ew-orchestrate.md)，长链与决策门策略见 [自动与 Goal 策略](auto-policy.md)，分派/恢复命令见 [执行循环](orchestrator-run-loop.md)。

## Classification Protocol

1. **Exact match**（详见 [意图分类目录](ew-orchestrate.md)）：
   - `status` / `状态` / `dashboard` → 只读短路径，路由至 `END`（呈现状态后即止，不推断开链）。
   - `continue` / `next` / `go` / `继续` / `下一步` → `S_CONTINUE`：通过 `evolve session list --status open` 校验活跃 Session（`1` 个继续执行，`>1` 个询问选择，`0` 个走冷启动回退规则）。
2. **Selection priorities**（`S_CLASSIFY` 严格按此顺序求值）：显式 `/ew-swarm`、显式 `/ew-odyssey` 或显式 `/workflow-evolve`（三者均为 `disable-model-invocation: true`，仅用户显式调用时命中，且 `/workflow-evolve` 仅用于修改 Skill/Harness）> Exact match 短路径 > 已有 compatible open Session > tracked issue（`--gaps`）> 前端 UI/设计（`ew-impeccable`，可自动路由）> 多步骤工程链 > 单步强契约任务 > `ew-companion`（已在 Evolve 管理的工程中或显式 `/ew-orchestrate` 下的单关注点 `<= 2` 文件改动）> `END`（零修改纯问答，或未启用 Evolve 编排的项目中的直接独立执行）。
3. **契约前置校验**：
   - `ew-verify` 在契约层面强依赖 `current-plan` + `current-execution`；缺任一上游时禁止单排 `ew-verify`（改走 `ew-review`，或先补 `ew-plan` → `ew-execute`）。
   - `ew-execute` 缺 `current-plan` 时前置 `ew-plan`（或降级为 `ew-companion`）。
   - `ew-test` 无 `latest-verification` 时至少需有 `current-execution` + `current-plan`、`latest-review` 或显式 `<scope>`。
4. **留痕要求**：必须记录匹配证据、排除备选方案与置信度；无记录不可进入 `S_CREATE`。
5. **权威路由表**：各类语义意图到初始链的完整映射与阈值以 [意图分类目录](ew-orchestrate.md) 的 `Semantic Intent -> Route Matrix` 为唯一权威来源。

## Decomposition Protocol (`S_DECOMPOSE`)

1. narrow / 单步链跳过分解，直接构造最小 `boundary_contract`（`in_scope: [intent]`、`definition_of_done: "step completed with passing gates"`）。
2. broad/medium 意图（影响 `>= 3` 个模块、需跨包接口变更、或范围/约束/完成标准中 `>= 2` 项不明确）最多询问 3 轮；`-y` 不跳过广泛歧义。
3. `--goal <goal>` 派生映射：将 `<goal>` 文本直接写入 `Session.objective`，并据此构造 `--definition-of-done`、`--boundary-contract` JSON 与面向结果的 `--goals` JSON 数组（每项含 `id`、`goal`、`boundary`、`done_when`、`evidence`、`lifecycle`、`status: "pending"`），连同 `--goal-mode` 持久化至 `evolve session create`。
4. 有分解时在 `session complete` 前插入 `--decision-only --decision-ref post-goal-audit --step-id goal-audit` 决策门；多里程碑拆分仅在多 release 证据时先走 `ew-roadmap`。

## Chain Creation (`S_CREATE`)

1. **Knowledge Gate**: 建链前通过 `evolve search "<query>" --mode context` 检索适用 Wiki 约束并记录读取。
2. **Skill 契约校验与 Git 绑定**: 按 [执行循环](orchestrator-run-loop.md) 的 Start and Dispatch 规范校验步骤契约并确保 Skill 已提交至 Git `HEAD`。
3. **持久化 Session 与 Chain**:
   - 通过 `evolve session create "<intent>" --id ew-<slug> [--definition-of-done "<text>"] [--boundary-contract '<json>'] [--goals '<json>'] [--auto] [--goal-mode] [--chain <commands...>] --actor <actor> --request-id <req_id> --reason "<reason>"` 持久化目标、边界与策略（不再停留在对话内存）。
   - 带领域参数、`--retry-max`、`--goal-ref`、`--stage`、`--decision-ref` 或 `--decision-only` 的步骤，使用 open 返回的 `orchestration_revision` 通过 `evolve session step add` 逐条写入。
   - 分解完成后可在回复中简要列出 `G1..Gn` 子目标及其 `done_when` 供用户确认（不要输出 `/goal` 斜杠命令）。

## Target Scope Resolution 优先级

1. 明确传入的目标路径、Session ID、Issue ID 或 `--from <alias>` 产物。
2. 当前项目活跃 Session 的 `goals[]` / 未完成步骤。
3. 多步链默认以 `{run_dir}` 隔离交付物；仍无法确定范围时使用宿主结构化提问能力向用户确认（见 [执行循环](orchestrator-run-loop.md#host-adapter-mapping)）。
