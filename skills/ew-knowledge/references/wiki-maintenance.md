# Wiki 与记忆维护参考

本文件汇总 `evolve kb` 的日常知识操作与跨宿主记忆提取，以及 `evolve search` 的聚合检索。`--scope project` 只查询项目，`--scope global` 只查询用户全局，默认 `--scope local` 合并两者。

## Wiki 索引、查询与摄入

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| 初始化 Wiki 模板目录 | `evolve kb init [--purpose "..."] [--schema "..."] [--force]` | 创建 `wiki/purpose.md`、`wiki/schema.md` 与 `wiki/entries/`（不覆盖已有自定义模板，不直写条目） |
| 重建 / 更新 Wiki 索引 | `evolve kb build` | 扫描并索引 `wiki/` 下的 Markdown 页面、标签/关键词/分类与依赖关系（`.evolve/index.db` 在缺失或 `wiki/` 变更时由知识检索自动构建/刷新） |
| 从源文档生成/合并 Wiki 页 | `evolve kb ingest <file.md\|file.txt> [--propose]` | 需配置 OpenAI 兼容模型接口；生成页面可被 `search --mode context` 检索，加 `--propose` 同时在 `closeout.db` 暂存 `entries/` 提案 |
| 检索与图谱展开 | `evolve kb search "<query>"` | 支持全文与关系检索 |
| 按范围列出约束 | `evolve kb list --kind constraint [--task <kind>] [--path <glob>] [--category <cat>]` | 解析对当前上下文生效的 `mode: constraint` 条目 |
| 按范围查询参考 | `evolve kb search --kind reference "<query>" [--task <kind>] [--path <glob>] [--repository <uuid>]` | 解析活跃 `mode: reference` 条目 |
| 精确读取条目与历史 | `evolve kb get <entry-id> [--resolved]` | 读取完整正文、作用域与修订历史 |

## 工作记忆写入、检索与多宿主同步

本地工作记忆保存在 `<root>/.evolve/memory.db`，可通过以下 CLI 直接读写或配置自动提取：

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| 手工写入记忆 | `evolve kb add --kind episodic "<text>" [--id <id>] [--type <type>] [--scene <scene>] [--session <session>]` | 立即保存工作经验并可供 `search --mode context` 召回 |
| 分页检索记忆 | `evolve kb search "<query>" --kind episodic [--type <t>] [--scene <s>] [--session <id>] [--page <n>] [--limit <n>]` | 返回短预览与后续读取参数，避免一次拉爆上下文 |
| 精确读取单条记忆 | `evolve kb get <memory-id>` | 按需展开全文 |
| 查看记忆旧版本 | `evolve kb history <memory-id>` | `kb update` 覆盖或 `kb delete` 删除前的内容会归档到 `memory_history`，已删除记录也可查回 |
| 追溯原始对话来源 | `evolve kb sources <memory-id>` / `evolve kb conversation <id> --host <host> [--page <n>]` | 分页查看原始对话上下文 |
| 从消息文件抽取 L1 记忆 | `evolve kb extract <messages.json> --session <id> [--mode chat\|code]` | 需配置模型接口（`AGENT_MEMORY_LLM_BASE_URL`、`AGENT_MEMORY_LLM_MODEL`、`AGENT_MEMORY_LLM_API_KEY`） |
| 配置与同步多宿主会话 | `evolve kb config --host <codex\|claude\|agy\|all\|off>`、`evolve kb sync --host <codex\|claude\|agy\|all> [--session <id>]` | 支持 Codex CLI、Claude Code 与 Antigravity 会话历史增量抽取 |
