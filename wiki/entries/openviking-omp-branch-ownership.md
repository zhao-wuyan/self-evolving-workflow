---
title: OpenViking 与 OMP 分支归属
mode: constraint
status: active
scope:
  - project
sources:
  - git:29ddf64890
  - git:2e6379df05
  - git:3d66d0a99b
---

与 OMP 无关的 OpenViking 策略、CLI、回放和通用 Git 忽略规则先在 `feat/openviking-integration` 开发和提交，再合并到 `omp-plugin-integration`。OMP 分支只新增宿主身份、斜杠命令、工具桥接及对应测试。两分支 README 分别维护，不将插件分发内容写进通用分支。仅当普通用户任务明确要求改变分支策略时才偏离此顺序。
