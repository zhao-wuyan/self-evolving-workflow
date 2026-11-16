# OpenViking 项目资产与知识接入执行计划

## Context

在已有 `feat/openviking-integration` 分支实现 `docs/openviking-integration-plan.md` 的目标：全局 Evolve CLI 使用 OpenViking 中的项目资产；Session 开始自动同步并固定版本，结束按执行证据进化、验证、合并和发布；Memory 搜索及精读同源，Wiki 保持受控治理。首次安装和联调使用隔离的 npm prefix、临时项目和远端私有命名空间，不覆盖现有全局安装或生产资产。规划期间已使用且已接收一个只读子代理的完整结果；实施阶段不再启动子代理。

## Approach

### 1. 恢复工具链并登记已批准计划

工作目录：`C:/Users/Zhaojinglin/orca/self-evolving-workflow`。

- 当前分支已由工具确认创建为 `feat/openviking-integration`。批准后先确认当前分支和初始用户改动；若用户已换分支，在当前 HEAD 新建 `feat/openviking-integration-<UTC YYYYMMDDHHmmss>`，不强制切换、不 stash/reset 用户文件。现有两份 `docs/openviking-integration-*.md` 保留。
- 已观察到缺少 `dist/workflow-cli.js`，安装版 `evolve` 也不可用，不能反复重跑缺模块检查。先执行 `npm ci`、`npm run build`，这是恢复知识入口，不是变更后的验证。
- 然后运行 `node dist/workflow-cli.js context "OpenViking Skill 同步" --include-memory`。依仓库知识门禁打开命中；零结果再查 `"memory backend"`。成功的零结果也记录为实际结果。
- 用现有 CLI 建立实施 Session，链为 `ew-plan,ew-execute,ew-verify,ew-review`；使用 CLI 返回的 revision、Run ID、run_dir，不猜 ID。`ew-plan` 只将本文件已经批准的选择物化为 `outputs/plan.json`，不另行设计或派工。读取每个 Run 的入口、required_links 和适用知识，按照其实际 contract 写入并封存产物。因用户限制，不执行 Skill 文档中的 2+1 子代理拓扑。
- `package.json` 已确认：Node >=22.16，build=`tsc -p tsconfig.json`，test=`npm run build && node --test test/*.test.mjs`，setup 含 `npm link`。本任务不用 `npm run setup`，也不改锁文件来绕过安装失败。
- 规划中的 TypeScript LSP references 请求以 server exit 0 失败。依赖恢复后优先重新启动 LSP 查询引用；仍失败才使用本计划给出的限定 grep 调用清单。实施者不得为此修改全局语言服务器设置。

后续步骤按依赖顺序实施；完成集成后统一运行 Verification，不在每步反复 build/test。

### 2. 建立唯一连接、项目配置与 CLI 入口

新建 `src/openviking/config.ts`、`src/openviking/client.ts`、`src/openviking/types.ts`、`src/openviking/cli.ts`。现有源码清单没有对应适配器，需要新增；不能修改 `src/upstream/` 或安装目录。

**连接**只复用现有 OpenViking CLI JSON：`process.env.EVOLVE_OPENVIKING_CONFIG` 指定的绝对路径，否则 `join(homedir(), '.openviking', 'ovcli.conf')`。文件字段使用实测的 `url`、`api_key`，不引入第二套凭据文件、login 命令或 URL/key 跨来源拼接规则。严格检查 HTTP(S) URL 和非空 key，不打印 key、Authorization、完整配置内容或可能带凭据的错误响应。

当前配置和接口已只读验证：`GET /health`、`GET /openapi.json` 均为 200；health 的实际版本是 `v0.5.5`，认证模式 `api_key`。OpenAPI 的 `info.version=0.1.0` 不是服务版本。客户端使用 `X-API-Key`，不发送账户/用户身份覆盖头。

项目配置为需要提交的 `.evolve/openviking.json`：

```ts
interface OpenVikingProject {
  schema_version: 'evolve-openviking-project/1.0';
  project_id: string; // 稳定 UUID，校验复用 isRepositoryId
  account_id: string;
  user_id: string;
  root_uri: string;
  evolution_policy: string; // 项目相对路径
}
interface EvolutionTarget {
  entry: string; // skills/**/SKILL.md，允许 ew-orchestrate/steps 下的入口
  scenarios: string; // 项目相对 JSON 路径
  runner: string; // 项目相对 Node runner 路径
}
interface EvolutionPolicy {
  schema_version: 'evolve-openviking-policy/1.0';
  targets: EvolutionTarget[];
}
```

策略必须有非空 targets；每个路径通过 `workflowPath()`，entry 必须在 `skills/` 内且 basename 为 `SKILL.md`。scenarios 沿用既有 `{id,input,baseline,knowledge_reads?}[]`，至少一条 baseline pass、一条 baseline failure，runner 沿用 `skill-replay.ts` 的 stdin/stdout 协议。策略和 runner 是本地项目 Git 管理的代码，不由远端清单改写。不得把默认“回答等于 expected 字符串”的 runner 当作实际项目行为验证；项目策略必须提供其业务 runner。

**默认 URI**：`viking://user/<health.user_id>/resources/evolve/projects/<project_id>`。这是同一账户、同一用户的多机共享，使用私有 resources 命名空间，避免依赖默认关闭且异步生效的共享 ACL。不会搜索整个用户 memories，也不修改账户 ACL 开关。每次连接核对 health 的 account/user 与项目描述一致；不一致报 `OPENVIKING_IDENTITY_MISMATCH`。

客户端接口：

```ts
class OpenVikingClient {
  health(): Promise<{version: string; account_id: string; user_id: string}>;
  stat(uri: string): Promise<{isDir: boolean}>;
  mkdir(uri: string): Promise<void>;
  download(uri: string): Promise<Buffer>;
  find(query: string, target: string, limit: number): Promise<Array<{uri: string; score: number}>>;
  batchWrite(root: string, operations: WriteOperation[], deferred: boolean): Promise<void>;
}
interface WriteOperation {
  uri: string;
  content_base64: string;
  mode: 'replace';
  if_absent?: true;
  expected_sha256?: string;
}
```

- `stat`、`mkdir` 使用 `/api/v1/fs/stat` GET、`/api/v1/fs/mkdir` POST；batch root 必须是已经存在的目录。逐级确保私有项目目录存在。mkdir 遇到 `ALREADY_EXISTS` 时仅在 stat 确认是同一目录后接受；其他 4xx/5xx 不吞掉。mkdir/索引生成的 sidecars 不属于项目资产清单。
- download 使用 `GET /api/v1/content/download?uri=...` 的 octet-stream，不能用摘要或按行读取替代文件字节。
- find 使用 `POST /api/v1/search/find`，body `{query,target_uri:target,context_type:'resource',level:2,limit,read_content:false}`；解析 `result.resources`，仅接受 URI、有限数值 score。`abstract/overview` 不是正文。
- JSON API 必须严格解析实测 envelope `{status,result,error,telemetry?,profile?}`。`content/read` 成功是 result 字符串，而不是随意兼容 content/text 三种猜测；本实现取完整文件主要使用 download。
- batchWrite 使用 `POST /api/v1/content/batch-write`，body `{root_uri:root,operations,wait:true,skip_conflicts:false,defer_processing:deferred}`。只认明确成功和无 queue errors 的响应。所有提交字节，包括 JSON 和 Markdown，都用 `content_base64`，避免字符串隐私替换破坏已批准字节；只允许明确的项目资产路径，不复制 CLI 凭据、整个工作区或原始对话。
- 请求采用 120 秒 abort；超时表示结果未知，不表示服务端回滚。保留服务端 error.code、HTTP status 和可恢复 task_id，错误不能退化为本地成功。
- 不使用 HTTP POST `/api/v1/search`：实测真实检索路径是 `/api/v1/search/find` 和 `/api/v1/search/search`。

`runOpenVikingCli(argv: string[]): Promise<void>` 独立严格 parseArgs；在 `workflow-cli.ts main()` 的 knowledge 路由之前按 `group==='openviking'` 转交完整 `argv.slice(1)`，保留 flag 顺序，不先用 workflow 的严格 options 丢掉专属参数。命令字面量：

- `evolve openviking init --policy <file> [--project-id <UUID>] [--root <project>]`
- `evolve openviking status [--root <project>]`
- `evolve openviking sync --session <id> --actor <actor> --expected-orchestration-revision <n> [--request-id <id>]`
- `evolve openviking finish --session <id> --actor <actor> --expected-orchestration-revision <n> [--candidate-commit <sha>] [--request-id <id>]`
- `evolve openviking memory share|unshare <local-memory-id> [--root <project>]`

init：要求现有 Git 仓库和 HEAD、有效 Git 提交身份及空 index；用 `installSkills()` 仅补缺失的随包 Skill，不覆盖现有包。project-id 未提供时，若已有 Wiki 中出现唯一 repository UUID 则复用它；没有则 randomUUID；出现多个则明确要求 `--project-id`，不能猜选第一个。已有描述文件只验证并返回，不重建远端。配置写入沿用 `memory-config.ts replaceJson()` 的 tmp/旧内容比较/rename 模式；只将非敏感描述文件纳入项目，连接文件不复制。描述文件和新安装 Skill 的基线提交采用步骤 4 的临时 index/commit-tree 模式，不使用用户 index，也不提交用户其他文件。初次创建远端后按步骤 3 发布 bootstrap；已有配置但远端不存在时报告错误，不自动重建一个空项目。

### 3. 用完整字节与单文件 CAS 实现项目发布协议

新建 `src/openviking/assets.ts`。不走 native `PUT /skills` 原位替换：v0.5.5 的 nested Skill roots 会被拒绝，原位更新先删除旧内容，文本还会经隐私替换；不能作为字节精确的版本库。项目 Skill 原件保存在私有 resources 资产库，执行仍由 Evolve 项目副本承担。

远端布局固定为：

```text
<root_uri>/blobs/<sha256>.bin
<root_uri>/releases/<release_id>/manifest.json
<root_uri>/releases/<release_id>/memory/<sha256(origin_id)>.md
<root_uri>/current.json
```

- Skill/Wiki 原始文件存 content-addressed blobs；原路径、mode、size 和 SHA 在 manifest 中。这样二进制、BOM、CRLF、空文件和名称与服务端 sidecar 冲突的辅助文件都不丢失，也无需自造 OVPack/ZIP。
- 源文件从 `git ls-tree -r -z`、`workflowBlob()`/Git blob 获取，不把 working-tree LF 转换当作真实文件。保留 `100644`、`100755` 和原始字节，不规范化 BOM/换行。遇到现有工作流不支持的 symlink/submodule 整包明确拒绝，不跳过。
- manifest 路径只允许 `skills/**`、`wiki/entries/*.md`、`memory/*.md`；应用 `workflowPath()` 并拒绝大小写折叠碰撞、重复路径和不支持的 mode。profile、policy、`.git`、数据库不能由远端覆盖。

在 types.ts 定义：

```ts
interface AssetFile { path: string; mode: '100644'|'100755'; size: number; sha256: string }
interface WikiApproval { id: string; payload_json: string }
interface SharedMemory {
  origin_id: string;
  path: string;
  metadata: Omit<MemoryRecord, 'id'|'content'>;
}
interface ProjectManifest {
  schema_version: 'evolve-project-release/1.0';
  project_id: string; account_id: string; user_id: string;
  parent: string|null;
  created_at: string;
  source_commit: string;
  cli_version: string;
  upstream: { cli_version: string; skills_sha256: string };
  files: AssetFile[];
  wiki: Array<{entry: string; path: string; approval: WikiApproval}>;
  memory: SharedMemory[];
  verification: {
    kind: 'bootstrap'|'evolved'|'knowledge';
    session_id: string|null;
    replay_ids: string[];
    validation_id: string|null;
  };
}
interface ProjectHead {
  schema_version: 'evolve-project-head/1.0';
  project_id: string;
  release_id: string;
  manifest_sha256: string;
}
```

`stableJson()` 递归按对象键排序、数组顺序保留；files 按 path 排序、wiki 按 entry、memory 按 origin_id 排序。`release_id = sha256(manifestBytes)`，manifest 本身不含 release_id。SHA 均为 64 位小写 hex。created_at 和 manifestBytes 在一个 job 开始后固定保存在 `.agent-memory/openviking/jobs/<session-or-init-id>/`，恢复时复用，不因时间变化制造新版本。bootstrap 如实使用 kind=bootstrap，不伪造回放记录。upstream 字段记录初次项目 Skill 基线，后续项目进化不自动改写；CLI 版本升级不会覆盖项目 Skill。

新增函数签名：

```ts
readProjectHead(client, project): Promise<{head: ProjectHead; raw: Buffer}>;
loadRelease(client, project, releaseId: string): Promise<ProjectManifest>;
publishRelease(client, project, manifest: ProjectManifest,
  bytes: ReadonlyMap<string, Buffer>, expectedHead: Buffer|null): Promise<ProjectHead>;
```

发布次序不可改变：

1. 先确保目录；按最多 4 MiB decoded bytes 组批上传缺失 blobs，单个更大文件单独成批。每个 blob 使用 `if_absent:true`、`defer_processing:true`。已存在 blob 必须下载后 SHA 相同才复用；不同则 `OPENVIKING_IMMUTABLE_CONFLICT`。不依赖 batch 原子性，失败可留下尚不可见的 blobs。
2. 用 if_absent 写 manifest，同样 deferred。校验本次新增 blobs 与 manifest 的服务器原始字节 SHA；不截断、不把服务器改写后的内容重新算作原始批准版本。
3. SharedMemory 的语义副本写到本 release 的 memory 目录，body 与 canonical blob 一致，batch `defer_processing:false`、`wait:true`。已有相同 body 但前次索引失败的副本，用 expected_sha256 重写相同字节完成索引；不能仅因文件存在就认为索引完成。检查 queue errors，下载副本核对 SHA。
4. 最后单独一条 batch 操作更新 current.json，`defer_processing:true`。首次发布用 `if_absent:true`；后续用 `expected_sha256=sha256(expectedHead 原始字节)`。绝不把 pointer 与 blobs 混在一个 batch：服务端按 URI 排序，不能靠数组顺序保证先写数据。

原子性证据已独立读过 v0.5.5 `openviking/storage/content_write.py:610–942,1041–1160`：对目标文件加 exact locks，锁内检查 expected/absence，再用同一 lease 写入；不是 root lock，不是多文件事务。current 的单文件 CAS 是唯一发布点。`content_base64` 解码成 bytes，`_sanitize_batch_operations():286–299` 只处理 str。

对 CAS 的 409 或网络结果未知，重读 pointer：等于本次目标字节则该提交已经发生；若指向其他 release，按步骤 8 合并。资源 busy 不冒充 CAS 成功。pointer 已指向本 release 后再被有效后继推进时，通过 parent 链确认本次已经发布，并返回当前 head 与本次 release 两个引用。不得拿超时当回滚，也不得用无条件 replace 重试。

### 4. 为自动准备与收尾增加受 fence 保护的 Session 状态

在 `workflow-runtime.ts Session` 增加可选字段；无此字段的本地 Session 完全保持原行为：

```ts
openviking?: {
  project_id: string;
  release_id: string;
  manifest_sha256: string;
  phase: 'preparing'|'ready';
  skill_commit?: string;
  publication?: {
    state: 'pending'|'running'|'no_change'|'published'|'failed'|'conflict';
    release_id?: string;
    error?: string;
  };
};
```

`WorkflowStore.open()` options 添加 `openviking?: {project_id,release_id,manifest_sha256}`，只保存 preparing seed。`open()` 的原事务内拒绝同一 root 下已有其他远端 preparing/open Session，或已有 publication pending/running 的 Session，错误 `OPENVIKING_ACTIVE_SESSION`。不建立网络事务，不另建一套 Session 数据库。

新增同步状态方法：

```ts
bindAssets(id: string, binding: {release_id:string; manifest_sha256:string; skill_commit:string}, change: Mutation): object;
recordAssetPublication(id: string, publication: NonNullable<NonNullable<Session['openviking']>['publication']>, change: Mutation): object;
```

两者复用 `change()`、revision CAS、request receipts。bindAssets 只作用于 open/preparing 或其同参数幂等重放；绑定 seed 必须一致，重验链中的 Skill 后设为 ready。recordAssetPublication 可以作用于 completed Session，但仍检查 revision 和合法状态迁移；不能用 mutate() 的 open 限制后偷偷改 DB。每次受 fence 的变更返回最新 orchestration_revision。

`validateStep(step, commit?:string)` 复用现有 `bindWorkflowSkill(root,command,commit)`。ready 的远端 Session：chain insert/replace、next、outputs 中 report.next 命令检查均传 `session.openviking.skill_commit`。preparing 时拒绝 next/chain，错误 `OPENVIKING_ASSETS_NOT_READY`。没有远端字段时仍默认 HEAD；现有 `evolve-workflow.test.mjs` 要求本地重试绑定新 HEAD，不改变该契约。

新增 `wikiRoot(id:string):string`：远端 Session 返回 `.agent-memory/openviking/releases/<release_id>/wiki` 对应的快照项目根；本地返回 this.root。`cliWikiPriors()` 改接收 Session 并用此根，outputs 的调用一起迁移。

在 `workflow-cli.ts session open` 以项目描述文件存在为自动启用条件：

1. 原样解析 actor/objective/chain。相同 ID 已有 Session 时复用其中不可变 seed 调用原 open，不能再次读最新 head 造成 request fingerprint 变化。
2. 首次只读远端 head 后调用 `store.open(..., {openviking:seed})`，从事务获得同一工作区的准备权。
3. 在事务外调用新建 `src/openviking/lifecycle.ts prepareSession()`：取完整 release、校验全部 Skill 与 Wiki blobs、构建快照、落地项目 Skill。
4. Git 落地复用 `skill-replay.ts` 的临时 `GIT_INDEX_FILE`、read-tree、hash-object、update-index、write-tree、commit-tree、merge --ff-only 模式，不调用 git add，不使用用户 index。拒绝 staged 内容和 managed Skill 路径未提交修改，不 stash/reset。删除只针对上一份清单拥有且新清单移除的文件；其余路径不动。提交消息 `chore: 同步 OpenViking 项目资产 <release前12位>`。Git mode 从 manifest 写入 tree，不能统一改成 100644。
5. 所有下载、治理和校验完成后才做 ff；已有字节/mode 集合完全一致则不造新提交。核对 HEAD 未被其他参与者推进，不合适就 `OPENVIKING_LOCAL_ADVANCED`，不重写用户提交。
6. 用获得的 revision 调 bindAssets，ready 后才打印成功；Run packet 暴露 openviking 固定信息。

准备失败保留 preparing 状态及固定 seed。`openviking sync` 用 fences 恢复同一 release，不改成最新。已有 Session A 不跟随远端指针变化；同一工作区在 A 完成前不自动物化另一版本，跨机器/独立项目工作区不受此限制。

### 5. 让已批准 Wiki 成为确定性快照，明确 Memory 发布授权

新建 `src/openviking/knowledge.ts`，复用 `listWikiChanges()`、`proposeWikiChange()`、`applyWikiChange()`、`readWikiEntryMetadata()`、`Wiki.build()`，不直接写 Wiki 条目或数据库。

**Wiki 导出**：初次 bootstrap 枚举正式 entry，每一条都要有 `listWikiChanges(wiki,{entry})` 的 applied 记录且 after 与当前原文一致；否则 `OPENVIKING_WIKI_UNAPPROVED`。保留 active、deprecated、needs_review、scope、aliases、categories、repositories、keywords、sources 全部原文。

后续以 Session 的已批准远端 manifest 为底图，只叠加本地尚未发布的 applied changes，不能因另一台机器没有本地 closeout.db 就丢掉远端知识。用 `.agent-memory/openviking/published-wiki.json` 记录 `{schema_version:'openviking-local-publication/1.0',changes:{[entry]:{change_id,result_sha256}}}`；只有确认本次 CAS 已提交后才推进。远端已经有相同字节及相同审批 ID 时可记为已同步。prepare job 还保存项目源 Wiki 的初始文件 SHA；本次改变但没有匹配 applied 记录的文件明确拒绝发布。未改变的旧源副本不覆盖远端快照；远端已批准的删除/废弃由其 manifest 决定，不因本地缺文件而擅自删除。物理删除不能代替现有 retire 审批。

将 applied preview 的 operation/entry/before/after/sources/candidate?/review? 按 `wiki-change.ts Change` 的既有插入顺序还原成 payload_json，校验 SHA 等于原 change ID；不能重新排序后假冒原 ID。

在 `wiki-change.ts` 新增：

```ts
proposeWikiSnapshot(wiki: Wiki, input: {entry:string; content:string; approval:WikiApproval}, evidence: readonly string[]): ReturnType<typeof proposeWikiChange>;
```

它仅供已验证项目 release 的新快照根使用：验证 approval payload hash、entry 和 after、完整 frontmatter；构造原有 operation=create 的 Change，after 保持原始字节，不把来源插进正文。将现有 propose 中保存/去重 Change 的代码提取为一个 private helper，共用原哈希、状态与 apply 路径；不新增 import operation，不删除原人类治理规则。相同快照可幂等应用，已有不同字节则拒绝。导入调用该函数再 applyWikiChange，来源为 release URI 与 SHA，根位于临时快照目录；全部成功并 build 后才原子 rename 成固定 cache。不能把未批准的检索内容转为 constraint。

远端 Session 的 Wiki 查询使用固定快照；普通 `wiki propose/apply` 仍操作项目源，变更要经过原人类审批，再由收尾导出到新 release。`context()` 和 MCP `wiki_context` 去掉对适用 constraints 的 `.slice(0,limit)`，limit 仅限制 references/memory。超出既有 5 MiB 证据上限明确失败，不能静默漏掉约束。

**Memory 分享**：`memory share <local-id>` 从本地 MemoryStore.get 取固定版本，在 `.agent-memory/openviking/share.json` 记录 `{schema_version:'openviking-memory-selection/1.0',changes:{[origin_id]:selection}}`。selection 为 `{operation:'share',version,content_sha256,metadata}` 或 `{operation:'unshare'}`；unshare 必须保留 tombstone，不能只删本地选择导致继承远端条目。文件以旧字节比较和原子 rename 保存。分享后正文/version 变化报 `OPENVIKING_MEMORY_APPROVAL_CHANGED`；发布后仅在选择项仍等于本次消费版本时清理该项，不能吞掉用户并发产生的新选择。

manifest.memory.metadata.exactValues 使用原记录 exactValues 与 `exactMemoryValues(content)` 的去重并集。同一原始 id 的元数据、正文、取消分享状态都参与三方合并；两边不同修改不能只按 version 数字取较大值。没有本地选择的条目继承已发布 manifest，不重新抽取。

发布只包含当前明确选择的 MemoryRecord 正文、原始 metadata/source IDs，不导出 conversation messages、host transcript 或 credentials。远端已有未被取消的共享条目继续保留；unshare 在新 manifest 中移除，历史 release 留作已固定 Session 的证据。不存在“双边各抽取一次”的链：本地既有提取生成候选，明确选择后上传，服务端只索引这份正文。

### 6. 将远端 Memory 原生接入 CLI、HTTP 与 Run MCP

新建 `src/memory-reader.ts` 的结构接口，不改 MemoryStore 写入模型：

```ts
type LocalSearch = Awaited<ReturnType<MemoryStore['search']>>;
type MemorySearchResult = Omit<LocalSearch,'strategy'> & {strategy:LocalSearch['strategy']|'openviking'};
interface MemoryReader {
  search(query:string, options?:MemorySearchOptions): Promise<MemorySearchResult>;
  get(id:string, options?:{knowledgeReads?:KnowledgeReads;fromSearchId?:string}):
    MemoryRecord|undefined|Promise<MemoryRecord|undefined>;
  close?():void;
  drainRemoteReads?():OpenVikingReadEvidence[];
}
```

MemoryStore 结构兼容，无 subclass、空 close 或 fake version。`SearchSources.memory` 改为 MemoryReader；`SearchResults.memory` 使用此 search 返回类型，`src/index.ts` 导出新类型。

新建 `src/knowledge-sources.ts`，统一 `openKnowledgeSources(root, options)`，供 `knowledge-cli.ts sourcesFor()`、直接 memory search/get、serve 和 `workflow-mcp.ts` 使用：

函数签名固定为 `openKnowledgeSources(root:string, options:{session?:string;db?:string;namespace?:string;wikiRoot?:string;traceFile?:string;memoryBackend?:'local'|'openviking';includeMemory:boolean}):Promise<{wiki:Wiki;memory?:MemoryReader;releaseId?:string;repositoryId?:string}>`。includeMemory=false 不打开数据库或创建虚假 reader；显式 memory 请求如果缺 reader 则明确报错。

远端 factory 的 repositoryId 取已绑定 project_id。CLI context、Wiki 只读分支和 Run MCP 在调用 Wiki 前，将缺省的 WikiContext.repository 补成该 ID；用户显式给定的作用域仍按现有校验和过滤规则处理。记录搜索时使用最终生效 scope，不能用某台机器新建的 CodeGraph ID 替代稳定项目 ID。测试必须包含 repository 限定约束，验证另一台机器缺少本地 codegraph 时仍生效。

同时迁移 `runKnowledgeCli()` 中 wiki 的 `search/get/constraints/references/reference` 只读分支到 factory 返回的 Wiki；`build/migrate/propose/changes/apply/ingest` 保持项目源写入路径，不能把 `context` 的远端 ID 再拿到旧本地正文中读。Wiki 只读分支与 context 的 `--session` 都表示当前 workflow Session。

CLI 若带 `--reads`，第一次远端查询就在伴随文件写入 `{schema_version:'openviking-reads/1.0',project_id,release_id,reads:[]}`；后续精读优先使用这份已绑定 release，即使没有再传 --session。显式 Session 与伴随文件 release 不一致就报错。无 Session、无既有伴随绑定才查最新 head，避免同名 Wiki ID 在搜索与精读之间漂移。

- 无 profile 或显式 `--memory-backend local`：原 MemoryStore、db、namespace、分页行为不变。
- 远端 profile：context/Wiki 只读命令的 `--session` 使用对应 ready Session 快照；memory/search 原有 `--session` 仍表示历史 Memory filter，不能改义，新增 `--workflow-session <id>` 用于当前 Evolve Session。无 Session 且没有已有 `--reads` 绑定的查询读取最新 head；serve 在启动时固定一个 head，避免同一服务进程搜索/精读漂移。
- `--wiki-root` 在普通显式本地知识操作继续有效；远端 Session 查询中若试图覆盖固定 Wiki root 则明确拒绝。
- 本地写入命令 put/extract/sync、sources/conversation/delete 保持原后端，帮助文本和返回的后续命令保留 backend/namespace/workflow-session，不能让用户写本地后误以为已远端发布。

远端记录 ID 必须自带版本：`ov:<release_id>:<base64url(origin_id)>`。search/get/context 返回这一稳定 opaque id，sourceMessageIds 保留真实来源；version/createdAt 等来自 manifest 的原 MemoryRecord metadata，不把远端 hash 填成整数 version。get 只接受对应项目 manifest 中的 ID；绑定 Session 时 ID 的 release 必须匹配；无 Session 时可以按 ID 精读历史 release，不能错误读取最新同名记录。

远端 search：只查 `<root>/releases/<release>/memory`；必须过滤为 manifest 已列出的叶子 URI，忽略生成的 abstract/overview、目录或其他项目。先按 manifest metadata 处理 type/scene/session；按既有分页语义取得足够候选并在过滤后切页，只为实际返回条目下载正文。对于 `exactMemoryValues(query)` 判定的精确标识，使用 manifest 的 exactValues 加内容精确核对路径，保留大小写/前导零，不依赖语义分数。get/download 逐条验证 size/SHA，永不截断 64 KiB 或把摘要冒充正文。

在 knowledge-cli.ts 把直接 get 改为 await；sourcesFor 改 async 并迁移 search/context/serve 三个调用；cleanup 统一 `memory?.close?.()`。Run MCP 改 await memory.get，工具描述不再写 local store，但维持 memory_search/memory_get 名字和先搜索再读取校验。

新增独立 provenance：

```ts
interface OpenVikingReadEvidence {
  record_id:string; origin_id:string; release_id:string; uri:string;
  content_sha256:string; fetched_at:string; via:'network'|'cache';
}
```

旧 `knowledge-reads/1.0` source/kind/version 不变。CLI 以 `<--reads文件>.openviking.json` 存 schema `openviking-reads/1.0` 的旁证，print 输出可附同名独立字段；MCP 通过 `recordKnowledge(..., remoteReads?)` 的可选第四参数写入 `Run.openviking_reads`。Run packet/封存记录保留它。CLI 模式 completeRun 从 `knowledge-reads.json.openviking.json` 验证并吸收旁证：release 对应 Session、ID 出现在本次 search/read、显式 read hash 一致。不同时生成第二份主 knowledge receipt；缓存读取如实写 via=cache 和原获取时间。

需要迁移的既有调用点已检索：`knowledge-cli.ts` sourcesFor、serve close、search/context finally、memory get；`workflow-mcp.ts` constructor/get/close；`http.ts` 只消费 SearchSources；`search.ts` 两处 search；`index.ts` 类型导出。用限定 `rg 'SearchSources|sources\.memory|memory\.get\(|recordKnowledge\(' src` 核对调用清单，不能只改 CLI 漏掉 Run MCP。

### 7. 复用现有进化流程，在全局安装下执行项目的固定脚本

新建 `src/model-client.ts`，原样移走 knowledge-cli.ts 的 private `createModelClient(root)`（:178–198），保留 `memoryModelSettings()`、`AGENT_MEMORY_LLM_*`、OpenAI-compatible `/chat/completions` 行为；knowledge-cli 和新 lifecycle 共用它，不借用 OpenViking API key 充当模型 key。

收尾只在原 completeSession 成功后启动。远端 Session 的 completeSession 事务顺便将 publication 设 pending；CLI 在事务外调用 `finishSession()`。本地 Session 不增加模型/网络行为。发布失败不撤销已完成业务 Session，输出独立 publication 状态、非零 exit code 和 `openviking finish` 恢复命令；不能假装发布成功。

finishSession 按顺序执行：

1. 用 recordAssetPublication 与 revision fence 标记 running，确认没有另一远端活动 Session 占用本工作区；恢复时使用持久化 job 的原输入，不重新生成一个候选。
2. `reviewSession(root,session,{model:()=>createModelClient(root)})` 读取已封存的真实 Run 证据。只将来源可核对、kind 属于 correction/error/retry/verified_fix/workflow_issue 的信号路由到实际读取的 Skill entry；按 ReviewedRun.skillRef 的完整 package_path/entry 匹配 policy targets。无信号且无已批准 Wiki/Memory 变更 → no_change，不创建 release。不匹配配置目标时 `OPENVIKING_EVOLUTION_TARGET_MISSING`，不随意改父 Skill。
3. 将本次 review 固定为 job 文件。给 evolve-loop.mjs 新增 `--review <file>`，与既有 session/execution/history 来源互斥，接受序列化 reviewSession 的 runs/signals；自动路径只用它，避免每个 target/round 反复调用模型。保留已有手动 history/execution 入口，不把其输入悄悄当成当前 Session 的归因证据。
4. 准备 FrozenKnowledge：把该 Session release 的 Wiki 快照、已发布 Memory 原文和元数据用公开 MemoryStore.putMany 构成独占输入库，再以读模式打开。全量知识哈希按排序后的逻辑 Memory 记录与 Wiki 文件字节计算，不对会被 SQLite WAL/checkpoint 改变的数据库文件本身取哈希。设置 `EVOLVE_KNOWLEDGE_SNAPSHOT=<绝对snapshot目录>`、`AGENT_MEMORY_DB=<冻结db>`，基线、候选和合并验证复用它；验证前后核对逻辑哈希，不联系最新远端。

   `MemoryStoreOptions` 增加 `readOnly?:boolean`；constructor 在此模式跳过 mkdir/建表并调用 `openDb(file,true)`，默认模式原样保留。factory 的 FrozenKnowledge 分支使用 readOnly=true；写入类 CLI 在此环境下直接拒绝，不先调用抽取模型。新测试验证写入被拒且快照正文没有变化。引用核对使用 `rg 'MemoryStoreOptions|new MemoryStore' src`，并更新 index 的既有类型导出，不新增平行 MemoryStore 实现。
5. 从 Session 固定 commit/materialized release 中启动 `workflow-evolve` 包的脚本，不从正在变化的 HEAD 随意取 driver；整个包已缓存，含相邻 memory-codex-mcp.mjs。显式传 `--memory-cli <随已安装包的 dist/cli.js>`、policy.runner/scenarios、`--iterations 1 --auto --review <file>`，设置 `EVOLVE_CLI=<随包的 dist/workflow-cli.js>`。cwd 仍为项目 root。
6. 保留 Agy discussion、候选回放、Agy confirmation、changeSkillVersion、应用后再验证和失败 revert。自动 review 分支新增零信号退出；discussion.evidence 必须是当前 review 中真实 sources 的子集，不能只验证非空数组。缺模型、runner、scenarios、确认失败或外部进程错误均不发布。

全局安装的实际缺口必须修复：项目复制的脚本默认 `../../../dist/cli.js` 指向项目而非全局包，codex-memory-replay.mjs 还直接 import yaml，项目没有 node_modules 时会失败。

- `workflow-cli.ts skills` 增加公开只读 `skills inspect <entry> --commit <sha>`，使用 workflowPath/workflowBlob/workflowHeader 返回入口 header/required_links；不读取 working-tree 替代指定 commit。
- codex-memory-replay.mjs 删除直接 yaml import，通过 `EVOLVE_CLI` 调用 inspect 取得 metadata；缺此变量时从显式 AGENT_MEMORY_CLI 所在 bin 目录定位同包 workflow-cli.js，找不到就明确要求配置，不能偷偷用其他全局版本。
- evolve-loop.mjs 与 codex-memory-replay.mjs 的 flat `skills/<id>/SKILL.md` 限制改为受 inspect 验证的 `skills/**/SKILL.md`，支持现有 `ew-orchestrate/steps/...`。draftSkillAddition/loadDraft 已支持这种目录，不再造另一套 draft 算法。
- memory-codex-mcp.mjs 的 CLI 子进程传递冻结快照环境，保持搜索 ID → get 的同源性。

### 8. 对并发远端变更执行三方合并与重新验证

在 assets/lifecycle 中实现固定的文件三方规则，base 为 Session 的 release，ours 为已经通过回放的项目资产候选，theirs 为当前远端 release：

- ours==base → theirs；theirs==base → ours；ours==theirs → 任一。
- 两边不同修改 UTF-8 正文：在隔离工作树调用 `git merge-file`，保留退出码；成功才接受。二进制双改、删除/修改冲突、mode 冲突、Wiki 审批链冲突不得任取一方。
- 只改正文之外的来源/审批数据时仍验证完整 entry 原文与审批 hash，不能通过合并把未审批的约束激活。
- 冲突保留 job 的 base/ours/theirs 和隔离工作树，标记 conflict，远端 current 不变。用户解决并提交后，用 finish 的 `--candidate-commit` 恢复；只接受 managed paths 的候选，重新验证，不能把 arbitrary commit 当成功凭据。

在 `skill-replay.ts` 新增：

```ts
verifySkillCommit(root:string, commit:string, targets:readonly EvolutionTarget[],
  knowledgeSnapshot:string): {id:string; commit:string; knowledge_sha256:string; targets:unknown[]};
readSkillReplayReceipt(root:string, id:string): ReplayReceipt & {id:string};
```

- readSkillReplayReceipt 提取并复用 changeSkillVersion 现有 receipt hash、Git ref、parent/changedFiles 校验；现有 apply/rollback 也调用它，不能在 publisher 中复制一个宽松的 reader。
- verifySkillCommit 复用 runPackageScenario、assertKnowledgeReads 和 worktree 生命周期，在指定 commit 对 affected targets 的所有既有 scenarios 检查 passed=true、loaded 文件 SHA、runner/scenario hash；原 baseline=false 标记在这里不要求仍失败。包含二进制/删除的合并用构造好的 Git commit 验证，不走只接受字符串 changes 的 loadPackageDraft。
- 无策略覆盖的 changed Skill 不允许发布。把完整验证记录保存为内容哈希文件，manifest verification.validation_id 引用它；最终候选 managed tree 必须与验证一致。
- 再检查 HEAD、managed dirty paths 和用户 index，必要时沿用 changeSkillVersion 的 ff-only 方式应用；不重写用户提交。
- 发布用步骤 3 CAS。若验证后远端又前进，可自动执行一次上述合并+重新验证+CAS；第二次竞争则明确 conflict 并保留恢复材料，不无限循环，也不改用 last-writer-wins。
- 即使没有 Skill 进化，只要存在明确批准的 Wiki/Memory 变化，也用相同 release/CAS 协议发布 kind=knowledge；没有内容变化不靠时间戳制造新版本。

recordAssetPublication 持久化 running→no_change/published/failed/conflict。completed Session 的失败收尾可由 finish 重入；terminal no_change/published 幂等返回，不能重跑模型或重复上传。失败状态允许后续业务 Session；恢复旧收尾前再次检查活动 Session、HEAD 与基线，不能覆盖后续工作。

### 9. 补齐行为测试与隔离安装入口

新增 `test/openviking.test.mjs`。复用 `test/evolve-workflow-support.mjs` 的临时 Git fixture、Node test/assert、真实 CLI 子进程和 JSON-RPC 驱动方式；按需实现本地 HTTP 协议 fixture，模拟 CAS/bytes/task 错误，不把 mock 结果宣称为真实服务接入。

必须覆盖以下消费者可见失败：

1. 两个项目 UUID 的发布与读取严格隔离；错误 account/user/root 路径拒绝。
2. 完整包含 PNG 任意 bytes、100755 脚本、空文件、CRLF/BOM、删除文件；跨两个临时项目往返后 Git bytes/mode 一致，用户无关修改与 index 不被提交。
3. 下载 hash 不符、manifest 路径穿越/大小写碰撞、缺失文件时，不 ff、不绑定 ready、不更新 current。
4. 单 pointer CAS 两个同时发布者只有一个基于旧 hash 成功；另一方保留候选并走三方合并。模拟“服务端写成功但客户端收到失败”，重读能识别成功，不制造重复版本。
5. Session A 中 retry/后续 step 固定同一 commit；远端新版本不改变 A，A 完成后 B 用新版本。本地无 profile 的既有 retry 仍绑定新 HEAD。
6. CLI context/search/memory get、HTTP search、Run MCP memory_search/get 返回同一正文与 SHA。远端摘要故意包含错误前导零，精读仍保留原值；通过 composite ID 精读旧 release 不误读最新同名记录。
7. 超过 10 条适用 constraints，context --limit 1 与 MCP 仍给出完整适用集；deprecated/其他作用域条目不生效。未批准远端 Wiki 不进入 binding 快照。
8. 零信号无 release；真实 sources 校验、模型失败、Agy 拒绝、runner 回退、候选回退均不发布；非重叠并发修改重新验证后发布，文本冲突与二进制冲突拒绝覆盖。
9. 崩溃点恢复：preparing 重入用原 seed，completed 收尾失败保持业务完成，finish 幂等。搜索/精读的远端旁证封存时能核对，旧主回执 schema 不变。
10. 同一冻结知识输入用于 baseline/candidate/merge，即使远端另发知识；project scripts 在没有本地 dist/node_modules 时能调用已安装 CLI，不 import 项目不存在的 yaml。

新增 opt-in `test/openviking-live.mjs`，不匹配默认 `*.test.mjs`：创建临时 npm prefix、两个临时项目和新的 UUID 私有远端根，通过真实 HTTP 与安装后的公开 bin 完成 Verification 的场景；不调用模拟 transport，不改现有全局安装，不遍历或删除用户其他远端数据。测试生成的 profile/policy、模型协议 fixture 只在临时项目内。真实模型进化单独标记，不能用固定响应代替后宣称通过。

## Critical files & anchors

实施前重读相应区域；行号仅作定位。

- `src/workflow-runtime.ts`：Session :96、change/mutate :298、open :330、next :447、cliWikiPriors :553、completeSession :735、recordKnowledge :797。网络不能进入 SQLite 事务，固定 commit 必须覆盖 chain 与 priors。
- `src/wiki-change.ts`：Change/preview/propose/apply/list；preview 已含 before/after 和 SHA，可导出审批证明。新 snapshot 入口复用治理存储而不直接写条目。
- `src/skill-replay.ts`：runScenario/runPackageScenario、replaySkillAddition、changeSkillVersion。复用隔离树、receipt、索引保护，不把任意 HEAD 当成验证通过。
- `skills/workflow-evolve/scripts/evolve-loop.mjs`：CLI 解析 :23–47、review :120、discussion :197、apply/verify :226。新增 review 输入与 evidence 归属校验，全局 CLI 路径显式注入。
- `skills/workflow-evolve/scripts/codex-memory-replay.mjs`：yaml import :6、flat entry :10、默认 CLI :37、MCP :57。这是全局安装且项目无 node_modules 时的关键缺口。

## Verification

### 本地与契约

批准实施后安装前置为 `npm ci`。完成全部变更后只构建一次：

```bash
npm run build
node --test test/openviking.test.mjs
node --test --test-name-pattern "pins each attempt|Wiki MCP|Agent Memory context envelope|identical model summaries" test/evolve-workflow.test.mjs test/integration.test.mjs
node test/codex-replay-contract.mjs
```

新测试 #2、#4、#5、#6、#7 是明确的新行为证明，不能只报告 typecheck。若检查失败，修根因，最多连续三次失败后重查知识与假设；不降低断言、不加入空 catch、不跳过不兼容路径。

### 实际安装和服务端

`test/openviking-live.mjs` 实现并执行下列固定流程，命令入口：

```bash
node test/openviking-live.mjs
```

- 从当前已构建项目执行 `npm pack --ignore-scripts --pack-destination <临时目录>`，再 `npm install --global --prefix <临时prefix> <tarball>`。使用该 prefix 的公开 evolve bin `--help`，不能继续拿源码 dist 冒充安装验证。Windows 按已有 CLI 子进程模式处理 npm.cmd/evolve.cmd，参数不是拼接不受控 shell 输入。
- 从现有 ovcli.conf 或 EVOLVE_OPENVIKING_CONFIG 获取连接，不打印 key。创建项目 A/B，先安装 Skill 并建立临时 Git 身份，配置覆盖测试入口的 policy。断言项目没有 dist/node_modules。
- A init 后真实发布包含二进制辅助文件的完整包；B 使用相同非敏感描述和同一用户连接拉取。比较完整字节集合与 Git mode。
- A Session 固定 R1。经受控候选验证发布 R2，A 的 run skill-read 返回 R1；A 结束后 B 新 Session 返回 R2。
- 分享具体 Memory，真实 find 与 download 后由 CLI/Run MCP 精读同一 composite ID；核对正文 SHA 和 provenance。已审批 Wiki 通过快照治理落地，状态/作用域和完整约束集合与本地契约相符。
- 对测试 current.json 发起两条相同 expected_sha256 的 CAS 请求，观察一方成功、另一方 409，原远端版本不被无条件覆盖。
- 服务端生成摘要/索引失败、连接配置缺失或 task 错误按实际结果报告。结束只清理测试自己的本地临时目录；不对用户远端历史做自动清理或账户管理。

真实模型路径另运行一次现有 `node test/codex-evolve-native.mjs`，它使用已安装的 Codex/Agy 和显式 fixture history，只能证明原生循环，不代替新的 Session 信号抽取与业务 runner 验证。新的完整自动收尾还需要 AGENT_MEMORY_LLM 配置及有业务意义的 policy；若它们不可达，必须报告这一未验证限度，不能将本地协议 fixture 的通过当成真实自动进化通过。

最终通过工具返回结果和行为输出报告文件、安装位置、项目 release、验证和真实模型限度；不要在变更后用 git diff/status/log 做额外审计。未被要求提交时不自动提交本次实现；若要求提交本次代码，使用宿主 eval commit namespace，中文 `类型: 描述`。

## Assumptions & contingencies

- 共享主体是同一账户/用户的多台机器；私有 resources URI 已由 v0.5.5 源码确认支持 batch-write。需要团队授权时必须另行改变共享范围，不能通过搜索所有用户 memories 偷偷实现。
- 现有服务明确支持 expected_sha256/if_absent/content_base64；若执行环境的 capability 检查不支持它们，拒绝启用远端项目并保留 local backend，不降级为无条件覆盖、文本限定包或手动替代自动 Session 钩子。
- 当前观察到 Codex、Agy 可执行文件存在，但没有 AGENT_MEMORY_LLM 环境变量，也没有项目 `.agent-memory/config.json`。模型配置继续沿用既有 `evolve memory config`/AGENT_MEMORY_LLM 方式；缺失时业务 Session 可以完成，自动收尾明确 failed 且零发布，修好配置后 finish 恢复。不得读取或挪用服务端模型凭据。
- 反向代理请求体限制、模型授权及 native 依赖安装属于实际环境前置条件。遇到 413 不截断资产，遇到 npm ci 失败不换 npm install 改写依赖图；核对并修复可达的根因，工具无法完成的环境条件如实报告。
- 本次批准目标包含可执行功能和隔离安装联调；不包含正式覆盖全局 CLI、修改账户配置或生产资产切换。CLI 升级只升级引擎；项目 Skill 基线与进化版本保持独立，不自动覆盖。
