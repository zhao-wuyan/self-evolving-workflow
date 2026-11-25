<div align="center">

# Self-Evolving Workflow

面向代码助手的自进化工作流：用可恢复的 **Session / Run** 编排任务，同步本地 **代码图谱 + 项目 Wiki + 工作记忆**，并基于执行证据回放改进 Skill。

[![CLI Release](https://img.shields.io/badge/CLI-GitHub%20Release-2088ff?logo=github)](https://github.com/zhao-wuyan/self-evolving-workflow/releases/tag/cli-latest)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.16.0-339933?logo=node.js&logoColor=white)](package.json)
[![Hosts](https://img.shields.io/badge/Hosts-Codex%20%C2%B7%20Claude%20%C2%B7%20Antigravity%20%C2%B7%20OMP-111827)](docs/install.md#2-安装工作流-skill)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[OMP 插件入口](#omp-插件入口) · [快速开始](#快速开始) · [安装与升级](docs/install.md) · [工作流 Skills](#工作流-skills) · [知识与代码图谱](#知识与代码图谱) · [Session 与 Run 指南](skills/ew-orchestrate/references/orchestrator-run-loop.md)

</div>

![Self-Evolving Workflow 总览，展示从任务到 Session、Run、验证封存及知识复用的流程](docs/images/workflow-overview.png)

## OMP 插件入口

需要 OMP 与 `Node.js >= 22.16.0`；插件内置完整 CLI 与子 Agent 定义，不用另装全局 `evolve` 或 OpenViking 即可本地使用。

```sh
omp plugin install 'https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/omp-latest/self-evolving-workflow-omp.tgz'
```

安装后重开 OMP，在项目目录输入 `/evolve-status` 即可使用：

| 在 OMP 输入 | 用途 |
| --- | --- |
| `/evolve-status` | 查看当前项目的 Session、最近 Run 与 Skill 安装状态。 |
| `/evolve-ignore check` / `/evolve-ignore apply` | 检查或补齐仓库根 `.gitignore` 的 Evolve 运行产物规则。 |
| `/evolve-migrate [旧项目目录]` | 预览并确认导入 Maestro Flow 旧知识。 |
| `/evolve-experience` | 单独管理个人跨项目经验库（`enable` / `pending` / `review` / `publish` / `search`）。 |
| `/evolve-openviking` / `/evolve-openviking status` | 一站式初始化 OpenViking 项目资产同步（弹窗选目录，默认 `.agents/skills/`），并可选补齐 `AGENTS.md` 引导与开启个人经验采集。 |

> 输入命令名后加空格可查看子命令补全；后两项需先[配置 OpenViking](docs/openviking-integration-plan.md#可拔插后端与故障策略)。

### 项目初始化与日常用法

- **OpenViking 一站式初始化（`/evolve-openviking`）**：
  - 全新项目默认推荐安装到跨宿主共享的 **`.agents/skills/`**（OMP / Antigravity / Codex / Claude 均可直读），也可在弹窗中改选 **`.omp/skills/`**（OMP 专属）或 **`skills/`**（通用根目录）；仓库若已存在唯一一套受管工作流目录则自动复用，存在多套会拦截提示。
  - 初始化自动创建空策略 `.evolve/evolution.json`（只同步资产，不自动修改 Skill）；完成后按需确认是否补齐项目根 `AGENTS.md` 受管区块与开启个人经验采集。Agent 定义不会自动提交或上传（OMP 插件自身已携带 `agents/`）。
- **纯本地安装（不启用 OpenViking）**：可请 OMP 用 `evolve_workflow` 执行 `skill install --scope project --host agy --yes`（安装到 `.agents/skills/`，或用 `--host omp` 安装到 `.omp/skills/` 与 `.omp/agents/`），再提交新增的 Skill 与引导文件。
- **Wiki 同步与知识收尾**：
  - 本地 Wiki 发布后若 CLI 返回 `openviking_sync` 提示，可请 OMP 执行 `openviking knowledge preview` 并经确认后 `knowledge publish --approval <哈希>`，无需重建 Session。
  - 知识收尾可执行 `kb harvest session <Session ID> --project <项目标识>` 与 `kb candidates show`；未配置独立 HTTP 模型时自动复用 OMP 的 `memory` 模型角色与认证，正式发布仍需审阅批准。

### 插件升级与项目 Skills 更新

插件升级不会自动覆盖已提交到项目的 Skills，建议按以下 3 步操作：

1. 终端执行 `omp plugin upgrade self-evolving-workflow` 并重开 OMP。
2. 在项目目录让 OMP 执行 `skill status --scope project`，查看 `skills_dir` 并核对是否存在本地修改或自进化内容。
3. 确认后用对应宿主执行升级（例如 `.agents/skills/` 用 `skill install --scope project --host agy --upgrade --yes`，`.omp/skills/` 用 `--host omp`），检查变更后提交到 Git。

> `status` 仅对比当前随包版本（不联网）；`--upgrade` 会整体替换内容不同的 Skill 目录且不自动合并，本地修改或自进化内容请先提交保存。详情见 [安装与升级指南](docs/install.md#4-安装记录状态检查与升级清理)。

## 快速开始

> 需要 `Node.js >= 22.16.0` 和 `Git`。完整宿主目录对照、安装记录与升级/清理用法见 [安装与升级指南](docs/install.md)。

```sh
# 1. 全局安装本 fork 的预编译 CLI（npm 或 mise 二选一；升级时重跑同一命令）
npm install -g "https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/cli-latest/self-evolving-workflow-cli.tgz"
# mise use -g node@24 "npm:https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/cli-latest/self-evolving-workflow-cli.tgz"

# 2. 在项目根目录安装 Skill（推荐 --host agy 安装到跨宿主通用的 .agents/skills/）
evolve skill install --scope project --host agy --yes

# 或导出/安装为各宿主原生插件包（Claude Code / Codex / Antigravity）
evolve skill install --plugin --scope project --host all --yes

# 3. 写入并验证一条工作记忆
evolve kb add --kind episodic "发布前运行回归测试。" --id quickstart-regression --type work_method --session quickstart
evolve search "回归测试" --mode context --session quickstart
```

> npm registry 的同名包属于上游，不用于更新本 fork；版本固定安装、`mise upgrade` 与 `cli-v*` 发布规则见 [安装指南](docs/install.md#1-安装-cli)。

升级已有安装并清理已退役旧包可执行 `evolve skill install --upgrade --prune --yes`，查看安装状态可执行 `evolve skill status`。常用会话恢复命令：`evolve session list`、`evolve session get --session <id>`、`evolve run get <run-id> --session <id>`、`evolve run read artifact <run-id> <alias> --session <id>`。

### 插件与 Marketplace 安装（Claude Code · Codex · Antigravity）

仓库已内置三平台插件与 Marketplace 清单（`.claude-plugin/`、`.codex-plugin/`、`.agents/plugins/marketplace.json`、`.antigravity-plugin/`），支持从仓库直接安装或通过 `evolve` CLI 导出隔离插件包（自动排除测试包 `release-gate`）：

```sh
# 1. 通过 evolve CLI 生成/安装原生插件包（支持 --scope project|user 与 --host codex|claude|agy|all）
evolve skill install --plugin --scope project --host all --yes
evolve skill status --plugin --scope project --host all

# 2. 仅导出独立插件包（不修改项目 AGENTS.md / CLAUDE.md）
evolve skill install --plugin --path ./dist-plugin --yes

# 3. 直接从 GitHub / 本地仓库添加到宿主 Marketplace
claude plugin marketplace add catlog22/self-evolving-workflow
claude plugin install self-evolving-workflow@self-evolving-workflow --scope user

codex plugin marketplace add catlog22/self-evolving-workflow
codex plugin add self-evolving-workflow@self-evolving-workflow

agy plugin install <path-to-exported-plugin-or-repo>
```

> 若先通过宿主安装插件，请按 [安装指南](docs/install.md#1-安装-cli) 安装本 fork 的全局 CLI（各宿主原生 `plugin install` 不会自动安装全局 CLI）。若项目同时启用 OpenViking 同步，建议使用唯一一套项目 Skill 目录（推荐 `.agents/skills/`），避免与 `--plugin --scope project --host all` 混用生成多份重复副本。详细路径对照与升级用法见 [安装与升级指南](docs/install.md#3-作为原生插件安装claude-code--codex--antigravity)。

## 工作流 Skills

![编排、知识与自进化六大核心工作流 Skill](docs/images/workflow-skills.png)

| Skill | 适用场景 |
| --- | --- |
| [ew-orchestrate](skills/ew-orchestrate/SKILL.md) | 串行编排初始化、规划、执行、验证与评审，轻量单步任务走内置 `ew-companion`。 |
| [ew-knowledge](skills/ew-knowledge/SKILL.md) | 统一承担 Knowledge Gate 检索、工作记忆同步、收尾沉淀、候选审查与 Wiki 发布/迁移。 |
| [ew-openviking](skills/ew-openviking/SKILL.md) | 指导 Evolve 与 OpenViking 共存时的知识路由、跨项目经验积累与项目资产同步。 |
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

## 迁移与开发

- **从 Maestro Flow 迁移**：`evolve kb import --knowhow-only` 预览，确认后加 `--apply` 写入 Wiki；支持 `--root <target>` 跨项目导入与 `--repository "<UUID>"` 范围检索。
- **源码测试**：`npm ci && npm test` 运行 TypeScript 编译与单元测试；`node test/ew-layout.mjs` 校验 Skill 包结构与链接。

## 致谢与许可

- 工作流设计与代码图谱钩子延续/参考自 [Maestro Flow](https://github.com/catlog22/maestro-flow)（[图谱初始化](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-auto-init.ts) · [图谱同步](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-sync-hook.ts)）。
- 记忆与 Wiki 引擎复用了 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/42d4cde50c5a83182fced8c584f9ddb32a620615) 的部分 MIT 实现。
- `ew-impeccable` 保留 Paul Bakaus / Maestro Flow 适配版 Apache-2.0 声明（[来源](skills/ew-impeccable/UPSTREAM.md) · [许可](skills/ew-impeccable/LICENSE) · [说明](skills/ew-impeccable/NOTICE.md)）；其余代码基于 [MIT 许可证](LICENSE) 开源。
