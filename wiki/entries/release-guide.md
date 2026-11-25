---
title: 版本发布标准流程（npm 与 GitHub Release）
mode: reference
status: active
scope:
  - project
categories:
  - coding
  - test
keywords:
  - release
  - publish
  - npm
  - github
  - changelog
  - tag
confidence: high
sources:
  - agy:63bb9fe0-4bdd-4187-9c24-4cee5c205d84:277
  - agy:95624df6-9300-4f84-a9ce-82b0a53d424b:438
  - commit:75594a92da16068291dd09a42638f1fec9467220
  - tag:v0.6.0
---

### [2026-11-24] 版本发布流程（锚点：self-evolving-workflow@75594a9）

本仓库在 2026-11-22 至 2026-11-24 的多次发布（v0.3.0 ~ v0.6.0）中形成了一致的标准发布流程：

1. **同步版本号与更新日志**
   - 统一更新以下 6 个文件中的版本号：
     - `package.json` 与 `package-lock.json`
     - `.antigravity-plugin/plugin.json`
     - `.claude-plugin/marketplace.json` 与 `.claude-plugin/plugin.json`
     - `.codex-plugin/plugin.json`
   - 在 `CHANGELOG.md` 顶部补充 `## [X.Y.Z] - YYYY-MM-DD`，分为 `### Highlights` 与 `### Verification`。

2. **发布前本地校验**
   - `npm test`（含 `npm run build` 与 `node --test test/*.test.mjs`）
   - `npm run test:ew-layout`
   - `node dist/workflow-cli.js skill validate --all`
   - `npm pack --dry-run`（核对 tarball 文件列表与解包体积）
   - 按需执行 `npm run test:release-gate-flow`

3. **本地提交与打标**
   - 确认工作区仅含发版相关改动后提交：`chore: 发布 vX.Y.Z`
   - 创建标签：`git tag vX.Y.Z`
   - 再次确认 `git status --short` 为空。

4. **推送 GitHub、发布 npm 与创建 GitHub Release**
   - 推送分支与标签：`git push origin main --tags`
   - 发布 npm 包：`npm publish`（依赖 `package.json` 的 `prepack: "npm run build"`；注意 npm registry 在上传后可能提示异步处理延迟，即时查询 `npm view` 可能短时间仍返回上一版本）
   - 创建 GitHub Release：`gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <scratch/vX.Y.Z-notes.md>`
     - 说明文件应写入工作区外部的临时目录或会话 `scratch/` 目录，避免在仓库内残留未跟踪文件。
     - Release Notes 结构沿用 `v0.5.0` / `v0.6.0` 格式：`## vX.Y.Z Highlights` 与 `## Verification`。

5. **发布后核验**
   - `gh release view vX.Y.Z --json url,tagName,name,publishedAt` 与 `gh release list --limit 3`
   - `npm view self-evolving-workflow version`（等待 npm registry 处理生效后确认 `X.Y.Z`）
