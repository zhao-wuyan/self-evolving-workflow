# 安装与升级指南

本文档说明如何安装 **Self-Evolving Workflow**（`evolve` CLI 与工作流 Skill 包）、查看安装记录，以及执行增量升级与旧包清理。

## 环境要求

- **Node.js**：`>= 22.16.0`
- **Git**：用于固定 Run 绑定的 Skill 提交版本

---

## 1. 安装 CLI

### 从 npm 安装

```sh
npm install -g self-evolving-workflow
evolve --help
```

### 从本地源码构建并链接

```sh
npm ci
npm run build
npm link
evolve --help
```

> **从旧包 `evolve-agent-memory` 迁移**：先执行 `npm uninstall -g evolve-agent-memory`；改用统一的 `evolve` 入口；现有 Wiki、记忆库与代码图谱仍可读取。

---

## 2. 安装工作流 Skill

在项目 Git 根目录执行 `evolve skill install` 可交互选择安装范围、目标 CLI 宿主与 Skill，也可通过参数非交互安装：

| 范围与宿主 | 命令 | Skill 安装位置 | 引导文件 |
| --- | --- | --- | --- |
| 当前项目（Codex CLI） | `evolve skill install --scope project --host codex --yes` | `.codex/skills/` | `AGENTS.md` |
| 当前项目（Claude Code） | `evolve skill install --scope project --host claude --yes` | `.claude/skills/` | `CLAUDE.md` |
| 当前项目（Antigravity） | `evolve skill install --scope project --host agy --yes` | `.agents/skills/` | `AGENTS.md` |
| 当前项目（OMP） | `evolve skill install --scope project --host omp --yes` | `.omp/skills/` | `AGENTS.md` |
| 当前项目（全部宿主） | `evolve skill install --scope project --host all --yes` | `.codex/skills/`、`.claude/skills/`、`.agents/skills/`、`.omp/skills/` | `AGENTS.md`、`CLAUDE.md` |
| 当前项目（通用无宿主参数） | `evolve skill install --scope project --yes` | `skills/` | `AGENTS.md` |
| Codex CLI（用户级） | `evolve skill install --scope user --host codex --yes` | `~/.codex/skills/` | `~/.codex/AGENTS.md` |
| Claude Code（用户级） | `evolve skill install --scope user --host claude --yes` | `~/.claude/skills/` | `~/.claude/CLAUDE.md` |
| Antigravity（用户级） | `evolve skill install --scope user --host agy --yes` | `~/.gemini/config/skills/` | `~/.gemini/AGENTS.md` |
| OMP（用户级） | `evolve skill install --scope user --host omp --yes` | `~/.omp/agent/skills/` | `~/.omp/agent/AGENTS.md` |
| 全部宿主（用户级） | `evolve skill install --scope user --host all --yes` | 上述 4 个用户级目录 | 对应 4 份用户引导 |

### 常用安装变体

- **仅安装指定 Skill**：追加 `--skill <名称>`（可多次传入，例如 `--skill ew-impeccable`）。
- **仅安装 Skill 包、不写入引导文件**：

  ```sh
  evolve skill install [包名...] [--host codex|claude|agy|omp|all]
  ```

- **项目级提交到 Git**：按项目安装后，请将已安装的 Skill 目录（`.codex/skills/`、`.claude/skills/`、`.agents/skills/`、`.omp/skills/` 或 `skills/`）与 `AGENTS.md` / `CLAUDE.md` 提交到 Git，以便 Evolve 将 Run 绑定到固定 Git 提交版本。
- **忽略本地运行时产物**：索引、数据库与过程文件统一保存在项目根目录的 `.evolve/` 下，建议在 `.gitignore` 中添加 `/.evolve/`（以及按需忽略代码图谱 `/.codegraph/`）。

---

## 3. 安装记录、状态检查与升级清理

安装器会自动记录每个目标目录的已安装 Skill 版本与内容摘要（SHA-256）：

- **项目级安装清单**：`<project-root>/.evolve/install-manifest.json`
- **用户级安装清单**：`~/.evolve/install-manifest.json`

### 查看当前安装状态

```sh
# 查看当前项目下各已配置宿主的状态
evolve skill status --scope project

# 查看用户级全部宿主的安装状态
evolve skill status --scope user --host all

# 仅针对项目目录检查
evolve skill status --host all
```

每个 Skill 会返回以下状态之一：`up_to_date`（与当前发布包一致）、`outdated`（本地副本已过期或有变更）、`not_installed`（尚未安装）或 `retired`（已改名或退役的历史 Evolve 包）。

`status` 使用安装清单及标准目录是否存在来识别目标，结果的 `skills_dir` 给出实际目录；没有清单也能发现标准目录。OMP 项目使用 `.omp/skills/`，用户级使用 `~/.omp/agent/skills/`。手动放到其他目录不会自动识别。

### 升级已有 Skill 与清理退役旧包

默认 `evolve skill install` 会跳过已存在 `SKILL.md` 的目录，避免覆盖本地文件。需要升级或清理时使用 `--upgrade` / `--prune` / `--force`：

升级来源为当前 CLI 随包 Skills，不会联网拉取上游；先升级 CLI，再检查项目状态。`--upgrade` 会替换内容不同的整个 Skill 目录，不自动合并本地或自进化修改；请先提交保存，再比较并合并。升级时沿用实际安装宿主（例如 OMP 使用 `--host omp`）；无 `--host` 的非交互项目安装只操作根目录 `skills/`。

```sh
# 项目级增量升级（仅替换内容不一致的 Skill 并补装缺失包，支持失败自动回滚）
evolve skill install --scope project --host agy --upgrade --yes

# 用户级全宿主升级并清理已退役旧包（如历史 team-swarm）
evolve skill install --scope user --host all --upgrade --prune --yes

# 升级指定 Skill 包
evolve skill upgrade --host all --prune

# 强制覆盖重装所有选中 Skill（即使内容哈希相同）
evolve skill install --scope project --host agy --force --yes
```

> `--prune` 仅会删除安装清单中记录的已退役 Evolve Skill 及已知历史旧包（如 `team-swarm`），不会删除用户自行编写的自定义 Skill。

---

## 4. 验证安装与首轮 Run

写入一条工作记忆并执行上下文检索，确认 CLI 与 `.evolve/` 存储工作正常：

```sh
evolve kb add --kind episodic "发布前运行回归测试。" --id quickstart-regression --type work_method --session quickstart
evolve search "回归测试" --mode context --session quickstart
```

确认返回的 `episodic` 中包含 `quickstart-regression` 后，即可让代码助手跑通首轮闭环：

> 读取项目的 `AGENTS.md`（或 `CLAUDE.md`）与对应宿主目录下的 `skills/ew-orchestrate/SKILL.md`，使用 `ew-companion` 开一轮 Evolve Run，验证刚写入的回归测试记忆能被检索，并完成 Session。

常用会话恢复命令：

- `evolve session list`
- `evolve session get --session <id>`
- `evolve run get <run-id> --session <id>`
- `evolve run read artifact <run-id> <alias> --session <id>`
