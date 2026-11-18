# Evolve Companion 内部路由

`ew-companion` 是 Evolve 内部的轻量单步执行通道，使用同一套 Session/Run 生命周期，省略多阶段拆解与复杂决策门；它是 `ew-orchestrate/steps/ew-companion/` 中的真实可绑定步骤，不创建第二套状态协议。

## `END` 与 `ew-companion` 边界

| 条件 | 路由 | 说明 |
| --- | --- | --- |
| 纯问答、只读解释或状态查询（零文件改写） | `END` | 不打开 Session，直接基于只读工具与 Knowledge Gate 作答 |
| 单关注点改动或状态变更检查（<=2 文件、明确位置、可直接验证） | `ew-companion` | 打开单步 Session 并走完整 Run 封存与证据留存 |
| 需架构/方案权衡、多任务分解、`>2` 文件修改或独立评审 | 主编排链 | `ew-analyze` / `ew-plan` / `ew-execute` / `ew-verify` / `ew-review` |

## 最小生命周期

1. 确认满足单步条件（目标明确、单一关注点、无需下游类型化工件消费、可由直接检查/测试验证）。
2. 通过 `evolve capabilities` 校验能力，打开仅含 `ew-companion` 步骤的 Session 并派发：

```text
evolve session create "<intent>" --id <slug> --actor <actor> --chain ew-companion
evolve run create --session <session-id> --actor <actor> --expected-orchestration-revision <revision>
```

3. 读取 `evolve run read skill <run_id> --session <session-id>`、加载项目知识（CLI `--reads`），如有 `latest-review` / `latest-debug` 上游输入通过 `evolve run read artifact` 读取。
4. 按边界改动并执行最窄验证命令；将操作记录与验证命令写入 `{run_dir}/outputs/companion-log.md`（带匹配 `companion-log/1.0` 的 YAML frontmatter），若过程中解决了非显而易见的问题或环境坑点，通过 `evolve kb add --kind episodic "<lesson>" --type verified_fix --scene coding --session <session-id>` 记录到工作记忆，然后封存 Run 并完成终态 Session：

```text
evolve run complete <run_id> --session <session-id> --actor <actor> --expected-orchestration-revision <rev> --expected-run-revision <run_rev> --summary "<observed change and verification>" --verdict done|done_with_concerns
evolve session complete --session <session-id> --actor <actor> --expected-orchestration-revision <rev>
```

5. Session 完成后按 `session complete` 返回的 `closeout_command` 转交 `ew-knowledge`（`evolve skill workflows show ew-knowledge`）处理候选知识（候选为零同样正常完结）。不要在业务任务执行中自动调用 `workflow-evolve` 或 `evolve session review`；仅当 `evolve_reminder` 确实反映了 Skill/编排流程本身的缺陷时，在收尾简要告知用户可显式使用 `/workflow-evolve`。

## 退出与升级

| 发现 | 处理 |
| --- | --- |
| 目标不明确或缺少完成条件 | 若仍属单步改动，暂停询问或 `evolve run cancel` 后记录阻塞并在澄清后重派 |
| 需要调查根因或跨模块影响（`>2` 文件） | **同 Session 升级**：保留当前发现，先对活跃 Run 执行 `evolve run cancel`（步骤退回 `pending`），再用 `evolve session step delete --step-id ew-companion-1 --evidence "<scope expanded>"` 跳过单步，并用 `evolve session step add` 追加 `ew-analyze` / `ew-debug` 等多步链（禁止遗留孤立 open Session） |
| 需要拆解任务或多步实现/审查 | 同上执行 `run cancel` + `chain skip ew-companion-1`，在同 Session 内 `chain insert` `ew-plan` → `ew-execute` → `ew-verify` / `ew-review` |
| 需要长期多轮审计或并行探索 | 关闭/跳过当前轻量链后，明确提示用户显式调用 `/ew-odyssey` 或 `/ew-swarm` |
