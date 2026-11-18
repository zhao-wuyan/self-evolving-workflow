---
name: ew-knowledge
description: Unified project knowledge governance — Knowledge Gate retrieval, working memory sync, Session/Skill closeout harvesting, candidate review, Wiki publication, and legacy migration.
argument-hint: "[intent — e.g. 'read <query>' | 'closeout <session-id>' | 'review' | 'publish' | 'migrate' | 'sync']"
session-mode: none
version: 0.2.0
---

# Evolve 知识治理

本 Skill 独立承担项目知识全生命周期治理，覆盖检索门禁、工作记忆、收尾沉淀、候选审查、Wiki 变更、历史迁移以及向 `workflow-evolve` / `ew-skill-design` 的分流。详细规范按需加载：

- [知识路由与规则](references/knowledge-route.md) — 统一 Wiki 模型（`mode: constraint|reference`）、ID 边界、`knowledge-reads/1.0` 回执、L3 初始化、旧知识迁移与分流标准。
- [收尾与候选晋升协议](references/closeout-protocol.md) — `Read → Refresh → Present → Ask → Execute → Verify` 收尾流程与权限边界。
- [Wiki 与记忆维护参考](references/wiki-maintenance.md) — `evolve wiki` / `evolve memory` 常用维护与多宿主历史提取命令。

## 意图路由

| 用户意图 | 路由 | 默认权限 | 主要入口 |
| --- | --- | --- | --- |
| 查约束、查参考、查术语、查 Wiki / 记忆 | `read` | 只读 | `evolve context` / `wiki constraints` / `wiki references` / `wiki get` / `memory search` |
| 记录或同步多宿主工作记忆 | `memory` | 显式写入记忆库 | `evolve memory put\|extract\|config\|sync` |
| Session 或独立 Skill 完成后的收尾沉淀 | `closeout` | 生成候选（不写 Wiki） | `evolve closeout session\|skill\|harvest\|scan` |
| 审查重复、重叠、冲突与证据 | `review` | 只读 | `evolve closeout show`、`evolve wiki get\|search` |
| 批准并发布 / 更新 Wiki 候选 | `publish` | 需明确人类授权 | `evolve wiki propose` → `evolve wiki apply` 或 `evolve closeout publish` |
| 个人跨项目经验 | `experience` | 查询和候选审阅只读，发布需固定人类授权 | `evolve experience status\|pending\|review\|search\|get\|publish` |
| 迁移 Maestro Flow 旧知识目录 | `migrate` | 先预览再 `--apply` | `evolve knowledge import` / `evolve wiki migrate` |
| 归因于具体 Skill 的问题或新流程需求 | `evolve` / `skill-design` | 只读回溯 / 路由 | `evolve session review` / `skills review` / `closeout route` → 交由 `workflow-evolve` 或 `ew-skill-design` |

## 核心不变式

1. **只读优先**：先识别操作与目标；检索结果、Closeout 候选、审计与回溯信号均只是证据，仅在明确授权发布时写入 `wiki/`。
2. **禁止绕过治理写入**：正式知识统一通过 `evolve wiki` / `evolve closeout` 写入，严禁直接创建或修改 `wiki/entries/`、`.workflow/specs/` 或 `.workflow/knowhow/`。
3. **`-y` 不是发布授权**：自动模式、高重要性标记、机器推荐或一般性同意审查均不授权 Wiki 发布；发布必须确认固定候选 ID、关系/目标与动作，否则保留待处理清单并延期（defer）。
4. **收尾与发布解耦**：零候选、拒绝或延期均可正常完成任务与 Session；禁止为凑条目把缺参考或一次性过程写成规则。
5. **不越权开启新链**：执行知识操作时不擅自新建 `Session` / `Run`，也不把未授权工作区自由文本混入收尾证据。
