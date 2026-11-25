# 安装与升级指南

本文档说明如何安装 **Self-Evolving Workflow**（`evolve` CLI 与工作流 Skill 包）、查看安装记录，以及执行增量升级与旧包清理。

## 环境要求

- **Node.js**：`>= 22.16.0`
- **Git**：用于固定 Run 绑定的 Skill 提交版本

---

## 1. 安装 CLI

### 从 GitHub Release 安装本 fork

发布首个 `cli-v*` 标签后，以下固定地址提供默认分支的预编译 CLI，无需 clone 或本地编译：

```sh
npm install -g "https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/cli-latest/self-evolving-workflow-cli.tgz"
evolve --help
```

升级时重新执行同一条 URL 安装命令。需要固定版本时，将 `cli-latest` 换成版本标签（例如 `cli-v0.6.0.1`）。不要使用 `npm update -g self-evolving-workflow` 更新本 fork；npm registry 的同名包由上游发布。

CLI 更新不会自动覆盖项目 Skills。在目标项目根目录执行 `evolve skill status --scope project --host codex`，保存本地修改后，再用 `evolve skill install --scope project --host codex --upgrade --yes` 更新；Claude Code / Antigravity 分别使用 `--host claude` / `--host agy`。

### 通过 mise 安装与更新

使用支持 npm tarball URL 的新版 [mise](https://mise.jdx.dev/dev-tools/backends/npm.html#install-from-a-tarball-url)，直接管理同一份预编译 Release 包（同样需要先发布首个 `cli-v*` Release）：

```sh
# 全局安装 Node.js 24 与本 fork 的 CLI
mise use -g node@24 "npm:https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/cli-latest/self-evolving-workflow-cli.tgz"
mise exec -- evolve --help

# 检查和更新 CLI
mise outdated "npm:https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/cli-latest/self-evolving-workflow-cli.tgz"
mise upgrade "npm:https://github.com/zhao-wuyan/self-evolving-workflow/releases/download/cli-latest/self-evolving-workflow-cli.tgz"
```

mise 以下载包的 SHA-256 摘要识别版本；`cli-latest` 内容变化后，`mise upgrade` 会安装新包。需要固定版本时，将 URL 中的 `cli-latest` 换成 `cli-v0.6.0.1` 等标签。不要使用 `npm:self-evolving-workflow`，它会指向上游 npm registry。

已通过 mise 管理兼容的 Node.js 时，可省略 `node@24`。去掉安装命令中的 `-g` 可将工具声明写入项目配置；后续在该项目目录执行更新。激活 mise 后可直接运行 `evolve`，也可始终用 `mise exec -- evolve ...`。CLI 升级后仍需另行更新目标宿主的 Skills。

### 与 OMP 插件并存

OMP 内置工具始终调用插件包自带的 CLI；终端中的 `evolve` 由当前 PATH 或 mise 配置决定。两者不会比较版本，也不会自动升级对方。更新全局 CLI 不会改变 OMP 插件正在使用的版本。

在同一项目中，两者会共享 `.evolve/` 中的工作流、记忆与安装记录；用户级数据使用同一个 `~/.evolve/`。Skills 按宿主安装到各自目录，但若两者都对同一宿主执行 `skill install --upgrade`，会使用各自随包 Skills 替换同一个目标目录，最后一次安装生效。升级前先检查状态并保存本地修改；OMP 插件与通用 CLI 分别通过各自的发布入口更新。

### 发布通用 CLI（维护者）

`.github/workflows/cli-release.yml` 监听 `cli-v<源码版本>.<CLI 修订号>`，例如源码 `package.json` 为 `0.6.0` 时使用 `cli-v0.6.0.1`，下一次修订为 `cli-v0.6.0.2`。标签提交必须属于 GitHub 默认分支，且不得声明 OMP 插件入口。

Action 执行 `npm ci`、构建、`npm pack`，并在隔离前缀安装运行 `evolve --help`，然后发布附件 `self-evolving-workflow-cli.tgz`。包版本为 `0.6.0-cli.1`，固定版本附件在重跑时保持不变；`cli-latest` 仅前进到较新版本。源码版本标签、OMP 的 `omp-v*` / `omp-latest` 与 CLI 的 `cli-v*` / `cli-latest` 分开管理。

```sh
# 在包含此 Action 的默认分支提交上打标签并推送
git tag cli-v0.6.0.1
git push origin cli-v0.6.0.1
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

## 3. 作为原生插件安装（Claude Code · Codex · Antigravity）

除直接拷贝松散的 `skills/` 目录外，本仓库也内置三平台插件与 Marketplace 清单，并可通过 `evolve skill install --plugin` 生成或安装隔离的宿主插件包（自动排除非发布测试包 `release-gate`）。

> **同步安装 `evolve` CLI**：Claude Code、Codex 与 Antigravity 的原生 `plugin install` 不会自动安装全局 CLI。若先安装宿主插件，请按本文第 1 节从本 fork 的 GitHub Release 安装 CLI（引导规则也会提示检查 `evolve --version`）。

### 方式 A：通过 `evolve` CLI 一键安装或导出插件包

```sh
# 1. 项目级：为全部宿主生成插件包并写入 Marketplace / 引导文件
evolve skill install --plugin --scope project --host all --yes

# 2. 用户级：安装到全局宿主插件目录（支持 codex / claude / agy / all）
evolve skill install --plugin --scope user --host all --yes

# 3. 检查与升级已安装插件包
evolve skill status --plugin --scope project --host all
evolve skill install --plugin --scope project --host all --upgrade --yes

# 4. 仅导出干净的独立插件包（不修改项目 AGENTS.md / CLAUDE.md）
evolve skill install --plugin --path ./dist-plugin --yes
evolve skill install --plugin --host all --path ./dist-plugins --yes
```

各宿主插件安装位置与后续启用命令如下：

| 宿主 | 范围 | 插件目录 | 清单 / 启用方式 |
| --- | --- | --- | --- |
| **Antigravity (AGY)** | 项目级 | `.agents/plugins/self-evolving-workflow/` | 内置 `plugin.json` + `rules/AGENTS.md`，工作区自动发现 |
| **Antigravity (AGY)** | 用户级 | `~/.gemini/config/plugins/self-evolving-workflow/` | 全局插件目录自动发现，可用 `agy plugin validate` 校验 |
| **Claude Code** | 项目级 | `.claude/plugins/self-evolving-workflow/` | `.claude/plugins/.claude-plugin/marketplace.json`；可执行 `claude plugin marketplace add ./.claude/plugins` 与 `claude plugin install self-evolving-workflow@self-evolving-workflow --scope project` |
| **Claude Code** | 用户级 | `~/.claude/plugins/local/self-evolving-workflow/` | `~/.claude/plugins/local/.claude-plugin/marketplace.json`；可执行 `claude plugin marketplace add ~/.claude/plugins/local` 与 `claude plugin install self-evolving-workflow@self-evolving-workflow --scope user` |
| **Codex** | 项目级 | `.codex/plugins/self-evolving-workflow/` | 自动合并写入 `.agents/plugins/marketplace.json`；可执行 `codex plugin marketplace add .` 与 `codex plugin add self-evolving-workflow@self-evolving-workflow` |
| **Codex** | 用户级 | `~/.agents/plugins/self-evolving-workflow/` | 自动合并写入 `~/.agents/plugins/marketplace.json`（Codex 隐式发现）；可执行 `codex plugin add self-evolving-workflow@self-evolving-workflow` |

### 方式 B：直接从本仓库或 GitHub 安装

仓库根目录已包含三平台插件与 Marketplace 清单：

- **Claude Code**：`.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`
  ```sh
  claude plugin marketplace add catlog22/self-evolving-workflow
  claude plugin install self-evolving-workflow@self-evolving-workflow --scope user
  ```
- **Codex**：`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`
  ```sh
  codex plugin marketplace add catlog22/self-evolving-workflow
  codex plugin add self-evolving-workflow@self-evolving-workflow
  ```
- **Antigravity (AGY)**：`.antigravity-plugin/plugin.json` + `rules/AGENTS.md` + `assets/logo.svg`
  ```sh
  agy plugin install <path-to-exported-plugin-or-repo>
  ```

---

## 4. 安装记录、状态检查与升级清理

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

## 5. 验证安装与首轮 Run

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
