<div align="center">

# Self-Evolving Workflow

面向代码助手的自进化工作流：用可恢复的 **Session / Run** 编排任务，同步本地 **代码图谱 + 项目 Wiki + 工作记忆**，并基于执行证据回放改进 Skill。

[![npm version](https://img.shields.io/npm/v/self-evolving-workflow?color=cb3837&logo=npm)](https://www.npmjs.com/package/self-evolving-workflow)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.16.0-339933?logo=node.js&logoColor=white)](package.json)
[![Hosts](https://img.shields.io/badge/Hosts-Codex%20%C2%B7%20Claude%20%C2%B7%20Antigravity-111827)](docs/install.md#2-安装工作流-skill)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[快速开始](#快速开始) · [安装与升级](docs/install.md) · [工作流 Skills](#工作流-skills) · [知识与代码图谱](#知识与代码图谱) · [Session 与 Run 指南](skills/ew-orchestrate/references/orchestrator-run-loop.md)

[OpenViking 接入](#openviking-服务可选) · [OMP Skills 与委派](#omp-安装与受限委派)

</div>

![Self-Evolving Workflow 总览，展示从任务到 Session、Run、验证封存及知识复用的流程](docs/images/workflow-overview.png)

## 快速开始

> 需要 `Node.js >= 22.16.0` 和 `Git`。完整宿主目录对照、安装记录与升级/清理用法见 [安装与升级指南](docs/install.md)。

```sh
# 1. 全局安装 CLI
npm install -g self-evolving-workflow

# 2. 在项目根目录安装 Skill（支持 codex / claude / agy / all）
evolve skill install --scope project --host agy --yes

# 3. 写入并验证一条工作记忆
evolve kb add --kind episodic "发布前运行回归测试。" --id quickstart-regression --type work_method --session quickstart
evolve search "回归测试" --mode context --session quickstart
```

升级已有安装并清理已退役旧包可执行 `evolve skill install --upgrade --prune --yes`，查看安装状态可执行 `evolve skill status`。常用会话恢复命令：`evolve session list`、`evolve session get --session <id>`、`evolve run get <run-id> --session <id>`、`evolve run read artifact <run-id> <alias> --session <id>`。

## OMP 安装与受限委派

使用本分支[从源码安装的 `evolve`](docs/install.md#从本地源码构建并链接)：

```sh
evolve skill install --scope user --host omp --yes
evolve skill install --scope project --host omp --yes
evolve agent exec "检查当前项目的测试覆盖" --to omp --mode analysis
```

前两条分别安装用户级 Skills（`~/.omp/agent/skills/`）和项目级 Skills（`.omp/skills/`），按需选择；项目 Skills 和引导文件应提交到 Git，供 Run 绑定版本。第三条委派一次只读分析。升级时先更新 CLI，再执行 `evolve skill status --scope project`；确认差异后用 `evolve skill install --scope project --host omp --upgrade --yes` 更新项目副本，存在本地或自进化修改时先保存再合并。需要斜杠命令？使用 [OMP 插件分支](https://github.com/zhao-wuyan/self-evolving-workflow/tree/omp-plugin-integration#omp-插件入口)。

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

本地工作流不需要 OpenViking。启用共享前，先在 `~/.openviking/ovcli.conf` 配置服务的 `url` 与 `api_key`，不要提交凭据。没有服务时，参照 [OpenViking 部署指南](https://docs.openviking.ai/en/getting-started/04-setup-for-agent)。

**共享项目 Skill、Wiki 和记忆**：在仓库根目录运行 `evolve openviking init`。首次会准备 `.evolve/evolution.json`，空策略只同步，不自动演进 Skill。详见[项目资产接入说明](docs/openviking-integration-plan.md#可拔插后端与故障策略)。

**发布收尾后新增的 Wiki**：本地审批发布成功后，CLI 返回 `openviking_sync` 状态及下一步命令；这一步不访问远端，也不代表已上传。已启用 OpenViking 的项目可直接预览并发布，无需重新创建 Session：

```sh
evolve openviking knowledge preview entries/preflight
evolve openviking knowledge publish --approval <预览返回的哈希>
```

预览不上传内容；确认展示的正文和项目目的地后再发布。已有“同步这些条目”的明确授权可直接使用。省略条目 ID 会检查本地已审批 Wiki；仅发布预览列出的差异，保留远端 Skills、Memory 和未选择的 Wiki，不触发 Skill 演进。本地内容或远端版本变化时重新预览；结果不确定时用同一批准哈希重试，CLI 核实远端版本后恢复回执。`openviking sync` 用于拉取 Session 资产，`finish` 用于完成 Session 的资产发布。

### OpenViking 个人经验库（可选）

只想跨项目复用个人经验，不必初始化项目资产。在目标仓库根目录运行：

```sh
evolve experience enable    # 开启当前仓库的采集
evolve experience status    # 查看是否开启
evolve experience disable   # 停止采集，不删除已发布经验
```

采集默认关闭，候选经验须经确认才发布。详见[经验检索](skills/ew-knowledge/references/knowledge-route.md#个人跨项目经验可选)和[审阅发布](skills/ew-knowledge/references/closeout-protocol.md#个人跨项目经验审阅)。

项目 Skill、引导文件、审阅后的 Wiki 和 OpenViking 项目配置可以提交；运行产物和凭据留在本地。

## 迁移与开发

- **从 Maestro Flow 迁移**：`evolve kb import --knowhow-only` 预览，确认后加 `--apply` 写入 Wiki；支持 `--root <target>` 跨项目导入与 `--repository "<UUID>"` 范围检索。
- **源码测试**：`npm ci && npm test` 运行 TypeScript 编译与单元测试；`node test/ew-layout.mjs` 校验 Skill 包结构与链接。

## 致谢与许可

- 工作流设计与代码图谱钩子延续/参考自 [Maestro Flow](https://github.com/catlog22/maestro-flow)（[图谱初始化](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-auto-init.ts) · [图谱同步](https://github.com/catlog22/maestro-flow/blob/master/src/hooks/kg-sync-hook.ts)）。
- 记忆与 Wiki 引擎复用了 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/42d4cde50c5a83182fced8c584f9ddb32a620615) 的部分 MIT 实现。
- `ew-impeccable` 保留 Paul Bakaus / Maestro Flow 适配版 Apache-2.0 声明（[来源](skills/ew-impeccable/UPSTREAM.md) · [许可](skills/ew-impeccable/LICENSE) · [说明](skills/ew-impeccable/NOTICE.md)）；其余代码基于 [MIT 许可证](LICENSE) 开源。
