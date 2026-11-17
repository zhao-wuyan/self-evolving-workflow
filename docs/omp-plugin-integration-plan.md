# OMP 插件集成：规划与恢复入口

## 当前实施进度

本会话已获用户授权开始开发，并确认 workflow.db 独立宿主审计表、项目初始化/Git 固定 Skills、仅工作流控制使用包内 CLI 子进程三项边界。唯一子代理用于独立计划审查，未发现阻断项；后续由主代理实施。

已实现正向 OMP extension、共享六工具服务、宿主事务回执、显式 Run bind/unbind/reset、活动分支恢复、取消隔离、固定知识源恢复与双安装入口。使用方式见 README 的「OMP 插件入口」。

规划与实现 Run 均已封存，Session `omp-plugin-integration-plan` 已完成。实现 Run 为 `run-99864979-ea79-4259-9224-c5167fbb4a42`；使用本 worktree 的 `node dist/workflow-cli.js run brief run-99864979-ea79-4259-9224-c5167fbb4a42 --session omp-plugin-integration-plan` 可查看封存结果，状态以 store 回执为准。

## 规划阶段停点（以下为历史记录）

最初用户要求只保存探查与 plan，在写插件代码前停止；本会话的新开发授权已替代该限制。

- 开发分支：`omp-plugin-integration`。
- worktree：`C:/Users/xinghe_zwy/orca/workspaces/self-evolving-workflow/omp-plugin-integration`。
- 指定基线：`origin/feat/openviking-integration`，已 fetch 并将新分支调整到 `376a1900cd9e233b2681fe6f908f7543f08189eb`。
- 原工作区：`C:/Users/xinghe_zwy/orca/self-evolving-workflow`；未将其未提交改动复制到新分支。
- 已完成：Orca worktree 创建、基线修正、源码/接口探查、依赖安装、规划与交接资料保存。
- 未开始：插件业务代码、配置/测试代码修改、构建、业务测试和插件安装验收。
- 没有启动外部开发 agent，没有自动提交，也没有推广知识。
- 依赖曾在最初基线执行 `npm ci` 成功；不要将其视为插件验收通过。后续按实际 lockfile 决定是否重新安装。

Orca 的 `baseRef` 字段仍保留首次创建时的 `refs/remotes/origin/main`。当前版本的 `worktree set` 没有重设该历史字段的参数；实际 Git HEAD 已调整为上述指定远程提交，Orca 回显的 `git.head` 已一致，comment 和 parent 已更新。不要根据旧 `baseRef` 再从 main 开始实现。

## 已确认的用户选择

1. 选择 `registerTool` 路线：知识工具在 OMP 进程内调用业务实现并直接写 store，不通过 MCP 子进程桥。
2. 同时支持 OMP 插件安装与普通直接安装，不能把项目变成只能在 OMP 中使用。
3. 普通知识消费要能追溯到真实 OMP session ID；绑定 Evolve Run 时仍满足既有证据链。
4. 本会话已授权开始实施，未确认的新边界仍先询问用户；最多一个子代理。

下述推荐边界已经用户确认；不再视为待批准方案。

## 新基线的实际能力与复用点

| 位置 | 已存在的能力 | 对本次设计的约束 |
| --- | --- | --- |
| `src/workflow-mcp.ts:15-128` | 六个 Run 绑定知识工具 | 抽出共享执行层，不能复制第二份 switch 或废弃其他宿主 MCP。 |
| `src/workflow-runtime.ts:867-898` | `recordKnowledge` 的 running Run 校验、事务、Wiki 快照和 OpenViking 校验 | omp session ID 不能冒充 Evolve Session ID；宿主关联与 Run 写入需原子提交。 |
| `src/workflow-runtime.ts:644-654` | Run 只接受 store 回执或单一文件回执，并校验远程绑定 | 单独写一个 omp JSON 文件不会自动满足 Run 完成检查。 |
| `src/knowledge-sources.ts:46-107` | local / OpenViking / cache / frozen reader 和 release 选择 | 普通会话不能误用别的 Run/release；复用而不是另造检索器。 |
| `src/knowledge-reads.ts:182-263`、`src/common.ts:32-53` | 统一回执结构和 SQLite 事务 | 不覆盖写整份 JSON；不在损坏后静默重置；不要先污染内存再尝试持久化。 |
| `src/workflow-skills.ts:116-167` | 从项目 Git commit 固定 Skill 内容与契约 | 插件发现 Skills 不等于 Run 能绑定插件目录中的文件。 |
| `src/workflow-install.ts:11-16,60-104` | 已支持 `--host omp`，保留已有 Skills/指令 | 不需要再添加一次 OMP host；不能覆盖用户修改，也不能假定重装会更新已有副本。 |
| `src/omp-worker.ts`、`src/workflow-delegate.ts` | 已有 OMP 受限 SDK worker / delegate | 这是 Evolve 调用 OMP 的反向链路，与 OMP 主会话调用 Evolve 的正向插件不同。 |
| `package.json` | 普通 npm 包、`evolve`/`agent-memory` bins、现有 exports | 增加 `omp.extensions`，保留普通入口；计划指向新正向 factory，不把 worker factory 当成主插件。 |

新基线中的 `omp-worker.ts` 已包含 `executeOmpWorker`；不能把更早在原工作区观察到的编译错误当成本分支当前结果。本轮没有运行构建，不宣称基线已通过编译。

## 推荐设计边界

### 1. 一个核心，三个薄适配入口

从 MCP 现有实现抽出共享知识服务，供 MCP 和 OMP extension 调用；普通 CLI 的外部行为保持兼容。

- 保留六工具：`read_skill`、`read_artifact`、`wiki_context`、`wiki_reference`、`memory_search`、`memory_get`。
- 正向插件使用 `evolve_` 前缀；前两项必须显式绑定有效 Evolve Run，未绑定时清晰拒绝，不制造假 Run。
- 原 `evolve mcp` 和 `evolve delegate --to omp` 保留。受限 worker 禁用了环境扩展发现，不能假定它自动继承新工具，也不要顺手删除其桥。
- 不为工具注册新增第二套 OMP 运行时依赖；宿主类型或薄适配层需要按真实版本校验。

### 2. 身份、分支与生命周期

- 使用 `ctx.sessionManager.getSessionId()`，不使用 session 标题。
- `session_start` 没有 `sessionId` 字段；不要再使用先前已删除草稿中的假设。
- 每个调用开始时固定 root、session、branch 关联、tool call ID、generation 和可选 Run 绑定。
- 宿主审计保存于 store；`appendEntry` 只记录命名空间化的关联 ID，通过活动 `getBranch()` 恢复有效关联。
- 覆盖 start/switch/branch/tree/clear/shutdown 与异步取消。A 会话的旧请求不得写入或 append 到新活动 B 会话。
- `registerTool` 的 execute 合同要独立核实，不能照抄 worker SDK customTools 的参数次序。

### 3. 回执事实源与事务

推荐在 `.agent-memory/workflow.db` 增加独立宿主记录，而不是伪造 Evolve Session/Run 或覆盖写 `.agent-memory/omp/<id>.json`。

- 未绑定 Run：只记宿主审计，保留搜索资格、精确读取、内容哈希、scope、backend/release 和调用身份。
- 显式绑定 Run：继续写现有 Run 回执，并在同一数据库连接/事务中写宿主关联；不补记绑定前的历史。
- 同一 tool call 的重放幂等；输入变更或身份不匹配明确拒绝。
- 失败必须回滚；持久化成功才返回成功。SQLite WAL 不能替代应用层冲突检查，也不能消除同步锁等待对 TUI 的影响。
- raw Wiki/Memory 内容保持工具数据身份，不拼入高优先级 `additionalContext`。

### 4. 安装、项目初始化与控制入口

- 同一包保留现有 bins/exports，计划增加 `omp.extensions: ["./dist/omp-extension.js"]`。
- OMP 原生 npm 插件安装已支持；插件市场 catalog 中的 npm source 则仍有限制，不能把两者混为一谈。
- 插件模式不再复制一套全局 Skills/AGENTS.md。普通安装继续可用；已有副本冲突时报告来源/版本，不静默删除。
- `manualSkills: ["ew-*"]` 会按 raw name 匹配多份副本，不是只隐藏普通安装旧版本的方案。
- 默认保留显式项目初始化与用户提交 Skills，满足现有 Git 固定契约。若要求零项目文件，必须另设计不可变包快照；不偷偷改成读取可升级的插件目录。
插件提供 `evolve_workflow` 控制工具，以 argv 数组调用包内 CLI，审批为 exec；知识工具仍全部 in-process。OMP 中 `process.execPath` 是 omp.exe，因此 bridge 定位真正的 Node，不依赖全局 evolve。

### 5. OpenViking 与知识源

缓存身份至少包含 root、配置/namespace、Run 绑定和 backend/release，不能只用 cwd。复用 pending 初始化、明确资源所有权与关闭路径；并行调用不能抢走对方的 `remoteReads`。保留 fixed release、哈希、failure_policy、verified cache 和 frozen snapshot 的现行规则。

Knowledge Gate 钩子可提高流程遵循度，但不是安全沙箱：仅拦截 read/grep 不能阻止通过 bash/eval 读取文件。本轮不顺带添加全局不可绕过门禁。

## 实施任务与顺序

任务的 `read_first`、写入文件、动作、依赖和验收标准以封存的 `outputs/plan.json` 为准；新增实现文件已按这些目标落地。

| 波次 | 任务 | 主要交付 |
| --- | --- | --- |
| W1 | TASK-001 | 核实真实 OMP 接口，冻结宿主调用上下文与 RunBinding。 |
| W2 | TASK-002、TASK-003 | 分别实现事务回执/Run 原子关联、知识源版本与生命周期；写入文件不冲突。 |
| W3 | TASK-004 | 抽取六工具共享执行层并迁移 MCP。 |
| W4 | TASK-005 | 实现正向 registerTool 扩展与显式绑定、分支恢复和取消处理。 |
| W5 | TASK-006 | 包 manifest、无全局 CLI 的控制入口、普通安装共存。 |
| W6 | TASK-007 | 增加消费者可见的隔离、回滚、恢复和兼容性回归场景。 |
| W7 | TASK-008 | 统一构建、窄测试、隔离配置下的真实 OMP 验收，随后更新 README。 |

TASK-001 至 TASK-008 的实现与验证证据记录在实现 Run 的输出和 report 中；历史探查或依赖安装不充当插件验收。

## 验收重点

1. 仅安装插件、全局 evolve 不可用时，知识调用和包内工作流控制仍可用；普通 CLI 安装保持可用。
2. 同标题不同 session ID、分支回退、clear、恢复、取消和切换均不串用搜索资格或回执。
3. 并发写入不覆盖、重复调用幂等、错误输入拒绝、失败事务不残留半条 Run/宿主证据。
4. 未绑定的精确读取与越界 Skill/工件读取拒绝；绑定后仍读取固定 Git/工件字节。
5. 插件与既有 MCP 的正文、约束和 OpenViking 证据一致；错误 release/哈希不被 fallback 隐藏。
6. 原 CLI/MCP/OMP delegate/安装流程继续通过其相关场景；不通过跳过、忽略或延长 timeout 掩盖错误。
7. 最终实际观察 OMP surface 的加载与工具执行，不只检查注册数量或 mock 工厂。

计划中的窄测试包括 `test/omp-plugin.test.mjs`（未来新增）、`test/omp-delegate.test.mjs`、`test/evolve-workflow.test.mjs`、`test/openviking.test.mjs`，以及 `integration.test.mjs` 中 OMP/普通安装的相关用例。实际命令见正式 plan；真实用户配置和外部模型额度不得成为默认测试依赖。

## 规划记录与恢复

- Evolve Session：`omp-plugin-integration-plan`。
- Evolve Run：`run-a00a2963-7773-4047-9a90-90c0d60ebddd`。
- Run 目录：`.agent-memory/workflow/runs/omp-plugin-integration-plan/run-a00a2963-7773-4047-9a90-90c0d60ebddd/`。
- 正式计划：上述目录的 `outputs/plan.json`。
- 规划检查记录：上述目录的 `outputs/plan-check.json`；只记录结构检查，不冒充独立审查或业务验收。
- 交接报告：上述目录的 `report.md`。
- 状态权威是本 worktree 的 `.agent-memory/workflow.db`。本文不是另一份生命周期状态库。

规划 Run 已在独立计划审查和用户确认后封存为 current-plan，并通过 Session amendment 记录本次开发授权。实现已分派到上述精确 Run；不再从历史规划 Run 重复分派。

本轮使用原工作区已经存在的编译 CLI 驱动规划，以避免为写计划提前构建新 worktree。新会话可先在本 worktree 正常构建现有 CLI；若不希望先构建，可用下面的已存在 CLI 只读恢复，`--root` 必须指向此 worktree：

```sh
node C:/Users/xinghe_zwy/orca/self-evolving-workflow/dist/workflow-cli.js run brief run-a00a2963-7773-4047-9a90-90c0d60ebddd --session omp-plugin-integration-plan --root C:/Users/xinghe_zwy/orca/workspaces/self-evolving-workflow/omp-plugin-integration
```

有本 worktree 的 `dist` 后，统一使用本地 `node dist/workflow-cli.js`。在 Run 内继续知识检索时，使用 brief 返回的实际 `run_dir` 和唯一 CLI `--reads <run_dir>/knowledge-reads.json`；本轮查询无命中，未加载任何 Wiki/Memory ID，不能虚报知识消费。

### 给新会话的启动提示

> 恢复时读取本文件的当前进度及实现 Run brief。分支为 `omp-plugin-integration`，基线为 `origin/feat/openviking-integration@376a1900cd9e233b2681fe6f908f7543f08189eb`，不是 main。当前已进入实现阶段，不重建重复 Session，不把下列历史规划验证范围当成最新实现状态。

## 本轮验证边界

已观察：指定远程分支 fetch 成功、rebase 成功、Orca 实际 HEAD 与目标提交一致；ew-plan 的 Git 绑定合同有效；规划所需源文件已探查；npm ci 成功。

未执行：本分支业务 build/test、插件实际安装/工具端到端验证、模型调用、OpenViking live 测试、独立计划审查、用户计划确认、Git commit/push。
