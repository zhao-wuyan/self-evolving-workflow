<div align="center">

# Self-Evolving Workflow

面向代码助手的自进化工作流：用可恢复的 **Session / Run** 编排任务，同步本地 **代码图谱 + 项目 Wiki + 工作记忆**，并基于执行证据回放改进 Skill。

[![npm version](https://img.shields.io/npm/v/self-evolving-workflow?color=cb3837&logo=npm)](https://www.npmjs.com/package/self-evolving-workflow)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.16.0-339933?logo=node.js&logoColor=white)](package.json)
[![Hosts](https://img.shields.io/badge/Hosts-Codex%20%C2%B7%20Claude%20%C2%B7%20Antigravity%20%C2%B7%20OMP-111827)](docs/install.md#2-安装工作流-skill)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[快速开始](#快速开始) · [安装与升级](docs/install.md) · [OMP 安装与委派](#omp-安装与受限委派) · [工作流 Skills](#工作流-skills) · [知识与代码图谱](#知识与代码图谱) · [跨项目经验](#openviking-个人经验库可选) · [Session 与 Run 指南](skills/ew-orchestrate/references/orchestrator-run-loop.md)

</div>

![Self-Evolving Workflow 总览，展示从任务到 Session、Run、验证封存及知识复用的流程](docs/images/workflow-overview.png)

`evolve` 为 Codex CLI、Claude Code、Antigravity、OMP 等代码助手提供可恢复的 **Session / Run 状态机**、自动同步的 **代码图谱 + 项目 Wiki + 工作记忆**，以及依据执行证据提案与回放的 **Skill 自我进化机制**。基础能力默认在本地运行，无需外部服务；需要跨项目复用验证过的经验时，可按仓库选择接入 OpenViking 个人经验库。

## 快速开始

> 需要 `Node.js >= 22.16.0` 和 `Git`。完整宿主目录对照、安装记录与升级/清理用法见 [安装与升级指南](docs/install.md)。

只用 OMP？直接看 [OMP 插件安装](#omp-插件入口)，无需全局安装 `evolve`。

```sh
# 1. 全局安装 CLI
npm install -g self-evolving-workflow

# 2. 在项目根目录安装 Skill（支持 codex / claude / agy / omp / all）
evolve skill install --scope project --host agy --yes

# 3. 写入并验证一条工作记忆
evolve kb add --kind episodic "发布前运行回归测试。" --id quickstart-regression --type work_method --session quickstart
evolve search "回归测试" --mode context --session quickstart
```

升级已有安装并清理已退役旧包可执行 `evolve skill install --upgrade --prune --yes`，查看安装状态可执行 `evolve skill status`。常用会话恢复命令：`evolve session list`、`evolve session get --session <id>`、`evolve run get <run-id> --session <id>`、`evolve run read artifact <run-id> <alias> --session <id>`。

## OMP 安装与受限委派

OMP 与其他宿主一样可安装工作流 Skill；用户级安装命令为 `evolve skill install --scope user --host omp --yes`，写入 `~/.omp/agent/skills/` 与 `~/.omp/agent/AGENTS.md`。

需要独立的只读分析或受控写入时，使用一次性受限进程：

```sh
evolve agent exec "<prompt>" --to omp --mode analysis|write [--role <name>] [--model <selector>] [--timeout <ms>] [--session <id> --run <id>]
```

默认 `analysis` 角色为 `@plan`、`write` 角色为 `@task`；显式 `--model` 优先于 `--role`，角色只选择模型，不进入 Plan 模式、不授予权限。`--timeout` 使用毫秒，默认 `600000`；`OMP_EXECUTABLE` 可覆盖可执行文件。该路径通过 `--trusted-extension` 加载随包 SDK bridge，无额外 OMP npm 依赖，不需要社区沙箱或容器；它是一次性受限 worker，不是托管的 OMP `start`/`send` 会话，也不支持 worktree 或 `--stream`。

严格 `analysis` 仅开放 `read`/`grep`/`glob` 和绑定的 6 个 Run 知识工具，不开放 `bash`/`eval`/`write`/`task` 或环境 MCP；`write` 开放读写工具、`bash`/`lsp` 和绑定知识工具，不覆盖用户审批、不启用 yolo。6 个 Run 知识工具通过共享的进程内执行提供，不启动 MCP 子进程。Codex/OMP 均支持同时传入 `--session`/`--run` 绑定，Agy 保持 standalone，现有 Codex 默认值不变。

该 CLI 委派与 OMP 可安装插件是两个独立入口：委派不加载插件工具，也不要求安装插件；插件打包与进程内工具属于 OMP 插件分支的分发面。原生 OMP `task`/eval `agent()` 的职责或 `tools` 名单不是 OS 权限隔离；第二意见须显式选择获授权模型，同模型子代理不等于独立模型验证。详见 [OMP 宿主适配](skills/ew-orchestrate/SKILL.md#omp-native-delegation-and-strict-cli-analysis)。

### OMP 插件入口

**OpenViking 不是插件安装依赖。** 本地 Session / Run、Wiki 和旧知识迁移不需要启动服务；启用远端项目资产或使用跨项目经验库时，先配置 [OpenViking 服务](#openviking-服务可选)。

需要 OMP 和 Node.js ≥ 22.16.0。从 GitHub Release 安装 **`omp-plugin-integration` 分支**的预编译包（不需要克隆、编译，也不需要全局安装 `evolve`）：

```sh
omp plugin install 'https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/omp-latest/self-evolving-workflow-omp.tgz'
```

重新打开 OMP，在目标项目输入 `/evolve-status` 验证插件已加载。可用 `omp plugin list` 查看安装记录。升级时对同一 URL 重新执行 `omp plugin install --force`，无需修改地址。

**发布新版（维护者）。** 标签格式为 `omp-v<上游版本>.<OMP 修订号>`：例如 `omp-v0.2.0.1` 表示基于上游 `v0.2.0` 的第 1 次 OMP 发布，包内版本为 `0.2.0-omp.1`。同一上游版本继续用 `.2`、`.3`；同步到新上游版本后从 `.1` 开始。源码的 `package.json` 保留上游版本，预编译包的版本由 Actions 写入。

先推送 `omp-plugin-integration`，然后在含发布 workflow 的提交上打标签并推送：

```sh
git switch omp-plugin-integration
git push origin omp-plugin-integration
git tag -a omp-v0.2.0.1 -m 'OMP: upstream v0.2.0, revision 1'
git push origin refs/tags/omp-v0.2.0.1
```

Actions 会构建并发布该版本，记录上游版本和提交，并更新 `omp-latest` 的 `.tgz` 附件。安装地址不变，不依赖仓库全局 Latest。普通分支推送不会发包，也不需要更改默认分支。

本地开发时才从源码构建和链接：

```sh
git clone --branch omp-plugin-integration --single-branch https://github.com/zhao-wuyan/self-evolving-workflow.git
cd self-evolving-workflow
npm ci
npm run build
omp plugin install .
```

`omp plugin install .` 会链接当前源码目录，不要删除或移动它。开发时拉取更新后重新执行 `npm ci` 和 `npm run build`，再重开 OMP。

知识工具在 OMP 进程内运行，不启动 CLI 或 MCP 子进程。`evolve_workflow` 以 `exec` 审批、固定的项目目录和 argv 调用包内 CLI，不经过 shell；需要 PATH 中有 `Node.js >= 22.16.0`，不需要全局 `evolve`。

| 工具 | 使用边界 |
| --- | --- |
| `evolve_wiki_context` / `evolve_memory_search` | 查找并记录当前 OMP 会话使用的知识 |
| `evolve_wiki_reference` / `evolve_memory_get` | 只读取当前有效分支已搜索到的 ID |
| `evolve_read_skill` / `evolve_read_artifact` | 先绑定运行中的 Evolve Run，再读取其固定 Git 版本和已绑定工件 |
| `evolve_run_binding` | 用 `bind` 同时提供 `session`、`run`；用 `unbind` 或 `reset` 清除绑定与搜索资格 |
| `evolve_workflow` | 调用 `session`、`run`（含 `run task`）、`skill`；个人经验只开放 `status/search/get` |

输入 `/evolve-experience` 加空格，即可在 OMP 的原生补全菜单中查看子命令、参数和中文用途；直接回车显示完整帮助。`enable`、`disable`、`status` 等结果直接显示为中文，不需要按 `Ctrl+Q`。`enable` 只更新用户级个人经验配置，不创建 `.evolve/openviking.json`，也不发布经验。

你也可以直接告诉 Agent「整理待发布个人经验，给出建议后统一提交确认」。Agent 会用 `evolve_experience_pending` 读取候选、说明建议，再用 `evolve_experience_publish` 显示预览并请求确认。也可手动用 `/evolve-experience publish <候选 ID> [更多候选 ID]`。取消不会发布；遇到变化或失败会停止并报告进度。两种入口均无需另装全局 `evolve`。

在目标项目的 OMP 会话输入 `/evolve-migrate [--knowhow-only] [旧项目目录]`，即可预览 Maestro Flow 的旧 Spec / Knowhow，确认后写入当前项目 Wiki。省略来源时使用当前项目，不修改旧文件，不转换旧 Session、Run 或工作流产物。

`/evolve-status` 不带参数即可查看当前项目的 Session / 最近 Run、Skill 安装情况、OpenViking 本地配置和个人经验采集状态。只读取，不初始化项目，也不探测远端。

要启用 **项目资产同步**，在目标仓库根目录执行 `/evolve-openviking init [策略文件]`（默认 `evolution.json`）。先提交策略、回放脚本与场景文件，并配置下文的 OpenViking 服务。命令会显示目标仓库、服务和策略，确认后才创建项目 Git 基线并向服务发布首个资产版本。只用个人经验库不需要执行此命令。

插件不会自动安装 Skills。显式调用 `evolve_workflow`，传入 `{"argv":["skill","install","--scope","project","--yes"]}`，再将项目 `skills/` 与 `AGENTS.md` 提交到 Git。已有副本默认保留，`kept_sources` 会报告路径、版本和包内容哈希。

宿主证据记录在项目 `.evolve/workflow.db` 的独立表（旧项目沿用原有数据库），OMP 会话分支仅保存关联 ID。绑定前的读取不会补记进 Run，同一个 Run 不混用文件回执与进程内回执。OpenViking release 在当前知识范围内固定；配置变更后须先 `reset`，再绑定和搜索。

## 工作流 Skills

![编排、知识与自进化六大核心工作流 Skill](docs/images/workflow-skills.png)

| Skill | 适用场景 |
| --- | --- |
| [ew-orchestrate](skills/ew-orchestrate/SKILL.md) | 串行编排初始化、规划、执行、验证与评审，轻量单步任务走内置 `ew-companion`。 |
| [ew-knowledge](skills/ew-knowledge/SKILL.md) | 统一承担 Knowledge Gate 检索、工作记忆同步、收尾沉淀、候选审查与 Wiki 发布/迁移。 |
| [ew-odyssey](skills/ew-odyssey/SKILL.md) | 独立发起的迭代排查（`debug`）、质量提升（`improve`）、多维评审（`review`）、安全/防御审计与 UI 优化。 |
| [ew-swarm](skills/ew-swarm/SKILL.md) | 对复杂或竞争性方案派出多路探索者并行实验、评分筛选与收敛。 |
| [ew-skill-design](skills/ew-skill-design/SKILL.md) | 设计或迁移 Skill，定义输入/输出契约并校验包结构。 |
| [workflow-evolve](skills/workflow-evolve/SKILL.md) | 从执行日志与记忆提取改进草案，经沙盒回放对比后再应用或回滚。 |
| [ew-impeccable](skills/ew-impeccable/SKILL.md) | Web 与原生移动界面的方向制定、评审、审计与打磨。 |

### Impeccable 界面设计

![Impeccable 的四个入口，分别用于定义方向、设计评审、检查质量和打磨细节](docs/images/impeccable-skill.png)

内置 Impeccable 4.9.2 设计手册与引擎（`impeccable.mjs`），核心链路覆盖 `shape`（定义方向）→ `critique`（设计评审）→ `audit`（检查质量）→ `polish`（细节打磨）：

```sh
evolve skill install --scope project --skill ew-impeccable --yes
evolve skill workflows show ew-impeccable
```

## 知识与代码图谱

- **Wiki 与工作记忆**：Run 通过 `evolve search "<query>" --mode context --reads <receipt.json>` 与 `evolve kb get` 读取知识时会生成带校验值的 `knowledge-reads.json` 回执；Wiki 检索索引与工作记忆等本地运行时数据统一收拢在 `.evolve/`，正式 Wiki 落在 `wiki/entries/`（详见 [知识路由](skills/ew-knowledge/references/knowledge-route.md)）。
- **增量代码图谱（`.codegraph/`）**：在 Git 根目录开启 Session 或查询符号时自动建库并按变更增量同步：
  ```sh
  evolve code search "<symbol>"
  evolve code graph "<symbol-id>" --direction callers --depth 2
  evolve code trace "<from-id>" "<to-id>"
  ```
- **多宿主同步与进化**：`evolve kb config --host all` / `evolve kb sync --host all` 同步 Codex CLI、Claude Code 与 Antigravity 会话记忆，再经 `kb harvest` → `skill draft` → `skill replay` → `skill apply` 完成 Skill 迭代。

### OpenViking 服务（可选）

复用一台可访问的 OpenViking HTTP 服务，或按 [OpenViking 官方部署指南](https://docs.openviking.ai/en/getting-started/04-setup-for-agent) 自行部署。Evolve 和 OMP 插件都不会自动安装或启动该服务，也无需另装 OpenViking 的宿主插件或 MCP。客户端连接读取 `~/.openviking/ovcli.conf` 中的 `url`（服务基地址）和 `api_key`（该服务签发的用户 API key）；也可用绝对路径的 `EVOLVE_OPENVIKING_CONFIG` 指定文件。不要把凭据提交到项目仓库。

- **共享项目 Skill / Wiki / 记忆**：在项目根目录用 `evolve openviking init --policy evolution.json` 显式启用，策略文件须先准备好。详见[项目资产接入说明](docs/openviking-integration-plan.md#可拔插后端与故障策略)。
- **跨项目个人经验**：单独用下节的 `evolve experience enable` 启用采集，不需要先初始化项目资产。

服务的 `/health` 需返回认证用户的 `account_id`、`user_id` 和服务版本。发布项目资产或个人经验需要服务通过 `/openapi.json` 暴露支持条件写入的 `/api/v1/content/batch-write`；能连通不代表能发布。

### OpenViking 个人经验库（可选）

**默认关闭。** 在要采集经验的 Git 仓库根目录运行：

```sh
evolve experience enable    # 复用已有连接，只启用当前仓库
evolve experience status    # collecting: true 表示当前仓库已启用
evolve experience disable   # 只停止当前仓库采集，不删除已发布经验
```

`enable` 使用已有 OpenViking 连接（默认 `~/.openviking/ovcli.conf`；可用绝对路径的 `EVOLVE_OPENVIKING_CONFIG` 覆盖）确认身份，自动创建或更新用户级 `~/.evolve/experience.json`，保留其他仓库的设置。无需手写经验配置、重填 API key，也不依赖项目级 `evolve openviking` 配置。`EVOLVE_EXPERIENCE_CONFIG` 可用绝对路径覆盖经验配置文件，适用于隔离测试。

- **只收有验证证据的经验**：由当前 `ew-test` / `ew-verify` 的 AI 提炼适用条件和验证结果；Session 完成后进本地待审队列，不另调模型。项目需使用并提交包含经验提炼支持的新版 Skills，已有 Run 不换绑。
- **人确认后才共享**：用 `evolve experience pending` 查看待审候选，`evolve experience review <候选ID>` 预览。启用不上传对话、源码或日志；经明确批准后只发布审阅过的经验，重复项补验证来源，冲突不覆盖旧条目。
- **按领域和版本按需查**：例如 `evolve experience search python python@3.12 "异步请求阻塞"`。未启用采集的仓库也能查已发布经验；经验仅作参考，项目规则优先。

详见[配置与检索](skills/ew-knowledge/references/knowledge-route.md#个人跨项目经验可选)和[审阅与发布](skills/ew-knowledge/references/closeout-protocol.md#个人跨项目经验审阅)。

## 哪些产物应提交到 Git

| 提交到 Git | 留在本地或发布渠道 |
| --- | --- |
| **项目级 Skill 和引导文件**：提交安装实际写入的 `skills/` 或宿主 Skill 目录（如 `.codex/skills/`），以及 `AGENTS.md` / `CLAUDE.md`。Run 从 Git 提交绑定 Skill 版本。 | **运行状态与缓存**：`.evolve/`、`.agent-memory/`、`.codegraph/` 下的 Session / Run 数据库、报告、回执、安装清单、待审队列和索引。 |
| **可共享的正式项目知识**：审阅 `wiki/entries/` 中新增或变更的 Markdown，仅提交适合仓库读者的条目。`/evolve-migrate` 确认后生成的条目也按此筛选，待审条目不要当成已批准知识。 | **私人数据与机器配置**：用户级 Skill、私有对话与经验、API key、`~/.openviking/ovcli.conf` 和 `~/.evolve/` 不进项目 Git；旧 `.workflow/` 作为迁移来源保留，不重新加入本仓库。 |
| **共享 OpenViking 项目资产时**：策略文件（如 `evolution.json`）和引用的回放脚本、场景文件须先提交。初始化会自动把不含 API key 的 `.evolve/openviking.json` 加入 Git 基线，无需手动暂存。 | **构建与发布产物**：`node_modules/`、`dist/` 和 `.tgz` 不提交。OMP 的预编译 `.tgz` 由 Actions 上传 GitHub Release。 |

暂存时用 `git add -- <已审阅的文件或目录>` 按路径添加，不要直接用 `git add .`。把值得共享的 Run 结论整理进正式项目文档或 Wiki，不要为了提交结论而强制添加整个运行目录。

## 迁移与开发

- **从 Maestro Flow 迁移**：`evolve kb import --knowhow-only` 预览，确认后加 `--apply` 写入 Wiki；支持 `--root <target>` 跨项目导入与 `--repository "<UUID>"` 范围检索。
- **源码测试**：`npm ci && npm test` 运行 TypeScript 编译与单元测试；`node test/ew-layout.mjs` 校验 Skill 包结构与链接。

## 致谢与许可

- 工作流设计与代码图谱钩子延续/参考自 [Maestro Flow](https://github.com/catlog22/maestro-flow)（[图谱初始化](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-auto-init.ts) · [图谱同步](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-sync-hook.ts)）。
- 记忆与 Wiki 引擎复用了 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/42d4cde50c5a83182fced8c584f9ddb32a620615) 的部分 MIT 实现。
- `ew-impeccable` 保留 Paul Bakaus / Maestro Flow 适配版 Apache-2.0 声明（[来源](skills/ew-impeccable/UPSTREAM.md) · [许可](skills/ew-impeccable/LICENSE) · [说明](skills/ew-impeccable/NOTICE.md)）；其余代码基于 [MIT 许可证](LICENSE) 开源。
