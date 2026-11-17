<div align="center">

# Self-Evolving Workflow

**别让代码助手写完就忘掉教训——把任务编排、项目知识与回放进化装进你的研发流。**

[![npm version](https://img.shields.io/npm/v/self-evolving-workflow?color=cb3837&logo=npm)](https://www.npmjs.com/package/self-evolving-workflow)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.16.0-339933?logo=node.js&logoColor=white)](package.json)
[![Hosts](https://img.shields.io/badge/Hosts-Codex%20%C2%B7%20Claude%20%C2%B7%20Antigravity%20%C2%B7%20OMP-111827)](#2-安装工作流-skill)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[30 秒上手](#-快速开始) · [为什么选择它](#-为什么选择-self-evolving-workflow) · [八大工作流 Skills](#-随包提供的-skills) · [Session 与 Run 指南](skills/ew-orchestrate/references/orchestrator-run-loop.md)

</div>

![Self-Evolving Workflow 总览，展示从任务到 Session、Run、验证封存及知识复用的流程](docs/images/workflow-overview.png)

`evolve` 为 Codex CLI、Claude Code、Antigravity、OMP 等代码助手提供可恢复的 **Session / Run 状态机**、自动同步的 **代码图谱 + 项目 Wiki + 工作记忆**，以及依据执行证据提案与回放的 **Skill 自我进化机制**——零外部服务依赖，全部沉淀在你的 Git 仓库中。

---

## 💡 为什么选择 Self-Evolving Workflow？

大多数 AI 编程还停留在“一次性对话 + 手工复制规范”：上下文一清零就重踩相同的坑，长链路写着写着偏离架构，提示词改完好不好全凭体感。`Self-Evolving Workflow` 把经验变成可校验、可版本化的工程资产：

| 常见痛点 | 传统提示词模式 | Self-Evolving Workflow |
| --- | --- | --- |
| **经验流失** | 会话结束即清零，规范靠每次粘贴提醒 | 本地工作记忆 + 项目 Wiki + 代码图谱，每次 Run 自动触发 `Knowledge Gate` 并记录读取回执 |
| **长链路失控** | 中断后难接续，产物散落对话记录 | Session / Run 绑定 Git Skill 版本，支持 `evolve run brief` 断点接管与失败重试链 |
| **Skill 越改越乱** | 凭感觉改指令，退化难察觉 | 依据真实失败/重试证据起草改进，经沙盒回放对比基线与候选后再应用或回滚 |
| **界面千篇一律** | 容易落入默认模板，“AI 味”重 | 内置 Impeccable 4.1.3，覆盖方向决策、像素级对照检查、缺陷检测与打磨收尾 |

---

## ⚡ 快速开始

> **环境要求**：`Node.js >= 22.16.0`，以及用于绑定 Run Skill 版本的 `Git`。

### 1. 全局安装 CLI

```sh
npm install -g self-evolving-workflow
evolve --help
```

> 从旧包 `evolve-agent-memory` 迁移时，先运行 `npm uninstall -g evolve-agent-memory` 再安装本包；原有 `agent-memory` 命令仍保留为兼容入口，与 `evolve` 共用同一份 Wiki、记忆库与代码图谱。

### 2. 安装工作流 Skill

在目标项目 Git 根目录执行 `evolve install` 可交互选择安装位置与 Skill 包；也可以直接一条命令完成安装：

| 范围 | 命令 | 写入位置 |
| --- | --- | --- |
| **当前项目（推荐）** | `evolve install --scope project --yes` | `skills/`、`AGENTS.md` |
| **Codex CLI（用户级）** | `evolve install --scope user --host codex --yes` | `~/.codex/skills/`、`~/.codex/AGENTS.md` |
| **Claude Code（用户级）** | `evolve install --scope user --host claude --yes` | `~/.claude/skills/`、`~/.claude/CLAUDE.md` |
| **Antigravity（用户级）** | `evolve install --scope user --host agy --yes` | `~/.gemini/config/skills/`、`~/.gemini/AGENTS.md` |
| **OMP（用户级）** | `evolve install --scope user --host omp --yes` | `~/.omp/agent/skills/`、`~/.omp/agent/AGENTS.md` |

按项目安装后请将 `skills/` 与 `AGENTS.md` 提交到 Git，Evolve 会把每个 Run 绑定到对应的提交版本；如只需特定工作流包，可追加 `--skill <名称>`。

**OMP 委派**：安装并授权 OMP 后，可用 `evolve delegate "<prompt>" --to omp --mode analysis|write [--role <name>] [--model <selector>] [--timeout <seconds>] [--session <id> --run <id>]`。默认 `analysis` 使用 `@plan`，`write` 使用 `@task`；`--model` 优先于 `--role`，角色仅选模，不进入 Plan 模式、不授予权限。默认超时 600 秒，`OMP_EXECUTABLE` 可覆盖可执行文件。当前通过 `--trusted-extension` 加载随包 SDK bridge，无额外 OMP npm 依赖，不需要社区沙箱或容器。

严格 `analysis` 在独立进程中仅开放 `read`/`grep`/`glob` 和绑定的 6 个 Run 知识工具，不开放 `bash`/`eval`/`write`/`task` 或环境 MCP；`write` 开放读写工具、`bash`/`lsp` 和绑定知识工具，不覆盖用户审批、不启用 yolo。Codex/OMP 均支持同时传入 `--session`/`--run` 绑定，Agy 保持 standalone，现有 Codex 默认值不变。原生 OMP `task`/eval `agent()` 的职责或 `tools` 名单不是 OS 权限隔离；第二意见须显式选获授权模型，同模型子代理不等于独立模型验证。详见 [OMP 宿主适配](skills/ew-orchestrate/SKILL.md#omp-native-delegation-and-strict-cli-analysis)。

### OMP 插件入口

当前源码尚未发布新版本，开发时先构建再链接；普通 CLI、MCP 和 OMP delegate 入口继续保留：

```sh
npm run build
omp plugin link /path/to/self-evolving-workflow
# 发布包含插件入口的版本后，可用 omp plugin install self-evolving-workflow
```

插件不要求全局 `evolve`，但工作流控制仍需 `Node.js >= 22.16.0` 可执行文件在 PATH 中。知识工具在 OMP 进程内运行，不启动 CLI/MCP 子进程；只有 `evolve_workflow` 以固定项目目录、argv 数组和 `exec` 审批调用包内 CLI，不经过 shell。原生 npm 插件安装与 marketplace catalog 的 npm source 支持是两回事。

| 工具 | 使用边界 |
| --- | --- |
| `evolve_wiki_context` / `evolve_memory_search` | 搜索并记录当前真实 OMP session 的知识使用证据 |
| `evolve_wiki_reference` / `evolve_memory_get` | 只读取当前有效分支知识范围内已搜索到的 ID |
| `evolve_read_skill` / `evolve_read_artifact` | 必须显式绑定运行中的 Evolve Run；仍读取固定 Git 版本和已绑定工件 |
| `evolve_run_binding` | `action: "bind"` 加 `session`、`run` 显式绑定；`unbind` 或 `reset` 清除绑定与搜索资格 |
| `evolve_workflow` | 用 `argv` 调用 Session、Run、Skills、安装等控制命令；不用于绕过进程内知识工具 |

插件不会自动安装全局 Skills 或改写指令文件。需要运行工作流时，先显式调用 `evolve_workflow`，参数为 `{"argv":["install","--scope","project","--yes"]}`，再由用户将项目 `skills/` 与 `AGENTS.md` 提交到 Git；插件发现 Skills 不替代这份 Git 固定契约。已有副本保留，安装结果的 `kept_sources` 提供路径、版本和内容哈希用于识别冲突，不静默覆盖或删除。

绑定示例：`evolve_run_binding({"action":"bind","session":"your-session","run":"your-run"})`。绑定前的知识使用只留在宿主审计，不补记到后来绑定的 Run；同一 Run 不混用文件与 store 两种知识回执来源。

宿主证据保存在项目 `.agent-memory/workflow.db` 的独立表，OMP 分支只保存关联 ID。切换、分支回退和恢复按活动分支重建状态；`/clear`、unbind、reset 清除搜索资格和 Run 绑定。OpenViking release 在知识范围内固定，配置变化后需显式 reset，再重新绑定和搜索。记录仅覆盖本插件的知识调用，不采集聊天全文或其他插件调用，也不把知识正文注入高优先级提示。

### 3. 30 秒验证知识检索与首轮 Run

先写入一条本地经验并检索确认生效：

```sh
evolve memory put "发布前运行回归测试。" --id quickstart-regression --type work_method --session quickstart
evolve context "回归测试" --session quickstart --include-memory
```

确认返回的 `working_memories` 中包含 `quickstart-regression` 后，即可把下面这段话直接发给你的代码助手跑通第一轮闭环：

> 读取项目的 `AGENTS.md` 和 `skills/ew-orchestrate/SKILL.md`，使用 `ew-companion` 开一轮 Evolve Run，验证刚写入的回归测试记忆能被检索，并完成 Session。

**常用会话恢复与排查命令**：

- `evolve session list` —— 查看所有任务 Session
- `evolve session status --session <id>` —— 查看当前步骤与进度
- `evolve run brief <run-id> --session <id>` —— 接管断点时读取任务参数、绑定的 Skill 版本与上游产物引用
- `evolve run artifact-read <run-id> <alias> --session <id>` —— 读取上游或历史 Run 产物（详见 `evolve workflows show session-run`）

---

## 🧩 随包提供的 Skills

![编排、协作与自进化的六大核心 Skill](docs/images/workflow-skills.png)

全套工作流拆分为 **8 个可独立按需加载的 Skill 包**，兼顾长链路工程编排与轻量单步任务：

| Skill | 定位 | 适用场景 |
| --- | --- | --- |
| [ew-orchestrate](skills/ew-orchestrate/SKILL.md) | 任务主控编排 | 串行编排 `ew-init` / `ew-brainstorm` / `ew-grill` / `ew-blueprint` / `ew-roadmap` / `ew-analyze` / `ew-plan` / `ew-execute` / `ew-verify` / `ew-test` / `ew-auto-test` / `ew-review` / `ew-debug` / `ew-retrospective`，轻量任务走 `ew-companion` |
| [ew-knowledge](skills/ew-knowledge/SKILL.md) | 知识治理与沉淀 | 统一承担 Knowledge Gate 检索、工作记忆同步、Session/Skill 收尾沉淀、候选审查、Wiki 发布与迁移 |
| [ew-odyssey](skills/ew-odyssey/SKILL.md) | 迭代攻坚循环 | 独立发起的问题定位（`debug`）、质量提升（`improve`）、多维代码评审（`review`）、安全/防御审计与 UI 优化 |
| [team-swarm](skills/team-swarm/SKILL.md) | 并行蚁群探索 | 对复杂方案派出多路探索者并行实验、评分筛选与收敛 |
| [ew-impeccable](skills/ew-impeccable/SKILL.md) | 界面设计与工艺 | Web 与原生移动界面的方向制定、视觉实现、回归审计与细节打磨 |
| [ew-skill-design](skills/ew-skill-design/SKILL.md) | Skill 设计与打包 | 设计或迁移新 Skill，定义输入/输出契约并验证包结构合规性 |
| [workflow-evolve](skills/workflow-evolve/SKILL.md) | 回放驱动进化 | 从执行日志与记忆提取改进草案，用沙盒回放验证后再应用或回滚 |
| [release-gate](skills/release-gate/SKILL.md) | 发布就绪门禁 | 依据 Wiki 约束、制品校验和与冻结窗口检查发布状态并签发 `release-gate/1.0` |

### ✨ Impeccable 界面设计亮点

![Impeccable 的四个入口，分别用于定义方向、实现界面、检查质量和打磨细节](docs/images/impeccable-skill.png)

基于 Impeccable 4.1.3 适配并内置完整设计手册、自动化 slop 检测脚本（`detect.mjs`）与实时评审辅助（`serve-question.mjs`）：

- **`shape`**：明确产品真实约束与视觉方向，打破千篇一律的默认卡片模板
- **`craft`**：按测量规格与参考图落实界面实现
- **`audit`**：核查可访问性、响应式断点、性能与视觉一致性
- **`polish`**：在交付前清扫细节瑕疵并固化 `DESIGN.md`

```sh
evolve install --scope project --skill ew-impeccable --yes
evolve workflows show ew-impeccable
```

安装后即可让代码助手读取 [skills/ew-impeccable/SKILL.md](skills/ew-impeccable/SKILL.md) 对指定页面执行 `audit`（用户级安装支持在 Codex CLI 使用 `$ew-impeccable`，在 Claude Code / Antigravity 通过对应入口调用）。

---

## 🛠️ 三大工程底座

### 1. 知识门禁与可信回执（Wiki & Memory）
- **先查后改**：任务启动前通过 `evolve context "<关键词>" --include-memory` 或 Run MCP `wiki_context` / `memory_search` 检索生效规范。
- **防幻觉回执**：MCP / CLI 读取知识时会签发带搜索范围、条目 ID 与正文校验值的 `knowledge-reads.json` 回执，防止智能体未读先答或编造约束。
- **本地透明存储**：工作记忆与运行状态落在 `.agent-memory/`，正式 Wiki 落在 `wiki/entries/`。详情见 [ew-knowledge 知识路由](skills/ew-knowledge/references/knowledge-route.md)。

### 2. 自动增量代码图谱（`.codegraph/`）
在 Git 根目录打开 Session 或查询符号时自动建库，并在后续操作前自动按 Git 变更增量同步，不查代码时零开销：

```sh
evolve code search "<symbol>"
evolve code callers "<symbol-id>" --depth 2
evolve code trace "<from-id>" "<to-id>"
evolve search "<query>" --scope code
```

也支持 `evolve code build` 全量重建或 `evolve code sync` 手动增量刷新。

### 3. 多宿主历史同步与证据驱动进化
- **记忆自动提取**：支持为 Codex CLI、Claude Code、Antigravity 配置模型端点并同步历史对话记忆：
  ```sh
  evolve memory config --host all
  evolve memory sync --host all
  ```
- **闭环回放验证**：`closeout` 收割候选 → `skills draft` 生成补丁 → `skills replay` 在基线与候选间跑回归用例 → `skills apply` / `skills rollback`。

---

<details>
<summary><b>📦 从 Maestro Flow 迁移旧项目知识</b></summary>

在旧项目根目录先预览再导入，支持把 `.workflow/knowhow/` 沉淀转为规范的 Wiki `reference` 条目并建立索引：

```sh
# 仅导入 Knowhow（先预览，确认后加 --apply 写入）
evolve knowledge import --knowhow-only
evolve knowledge import --knowhow-only --apply

# 同时预览与导入旧版 Spec，或跨项目导入到 --root 指定目标
evolve knowledge import [<source-project>] --root <target-project>
```

带有仓库范围限制的条目可通过仓库 UUID 精准召回：

```sh
evolve wiki references "关键词" --repository "<仓库 UUID>"
```

更多细节参见 [迁移与项目范围](skills/ew-knowledge/references/knowledge-route.md)。

</details>

<details>
<summary><b>🧑‍💻 源码开发与回归测试</b></summary>

```sh
git clone https://github.com/catlog22/self-evolving-workflow.git
cd self-evolving-workflow
npm ci
npm test
```

- `npm test` 会编译 TypeScript 并运行单元测试 suite。
- `node test/ew-layout.mjs` 校验全部 Skill 包目录结构、相对链接与布局约束。
- 本地调试可直接通过 `node dist/workflow-cli.js --help`（`evolve`）与 `node dist/cli.js --help`（`agent-memory`）调用。

</details>

---

## 🙏 致谢与许可

- 工作流 Session、Run 与 Skill 生命周期设计延续自 [Maestro Flow](https://github.com/catlog22/maestro-flow)，代码图谱初始化与增量同步钩子参考了其 [图谱初始化](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-auto-init.ts) 与 [图谱同步](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-sync-hook.ts)。
- 本地记忆与 Wiki 引擎复用了 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/42d4cde50c5a83182fced8c584f9ddb32a620615) 的部分 MIT 开源实现。
- `ew-impeccable` 基于 Paul Bakaus 创建的 Impeccable（经 Maestro Flow 适配），完整保留其 Apache-2.0 许可证与第三方声明：[来源与版本](skills/ew-impeccable/UPSTREAM.md) · [许可证](skills/ew-impeccable/LICENSE) · [第三方说明](skills/ew-impeccable/NOTICE.md)。
- 本仓库其余代码基于 [MIT 许可证](LICENSE) 开源。
