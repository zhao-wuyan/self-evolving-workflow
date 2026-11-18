import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { InputError } from '../common.js';
import { createModelClient } from '../model-client.js';
import { reviewSession, type ReviewedRun, type SkillSignal } from '../retrospective.js';
import { readSkillReplayReceipt, verifySkillCommit } from '../skill-replay.js';
import { installSkills } from '../workflow-install.js';
import { WorkflowStore, workflowId, type Mutation } from '../workflow-runtime.js';
import { bindWorkflowSkill, workflowHead, workflowPath } from '../workflow-skills.js';
import { Wiki, readWikiPages } from '../wiki.js';
import { readPolicy, readProject, privateProjectUri, projectFile, replaceJson } from './config.js';
import { ensureDirectory, isMissing, OpenVikingClient, OpenVikingError } from './client.js';
import { downloadAsset, loadRelease, manifestBytes, publishRelease, readProjectHead, releaseIsAncestor, sha256, stableJson } from './assets.js';
import { acknowledgeKnowledge, cacheRelease, exportMemory, exportWiki, fileRecord, sourceWikiHashes, type WikiPublicationChanges, type MemorySelection } from './knowledge.js';
import { applyAssetCommit, assertCleanIndex, assertManagedClean, createAssetCommit, gitBytes, gitText, skillAssets } from './git.js';
import { freezeKnowledge, frozenKnowledgeHash } from './frozen.js';
import { mergeProjectAssets } from './merge.js';
import type { AssetFile, EvolutionTarget, OpenVikingProject, ProjectManifest } from './types.js';

const bundle = fileURLToPath(new URL('../../', import.meta.url));
const cliVersion: string = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')).version;

function saveJob(path: string, value: unknown) { replaceJson(path, existsSync(path) ? readFileSync(path) : undefined, value); }
async function locked<T>(folder: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'lock.json');
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    let active = true;
    try { process.kill(previous.pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      active = false;
    }
    if (active) throw new InputError('OPENVIKING_JOB_BUSY');
    rmSync(path);
  }
  const owner = randomUUID();
  writeFileSync(path, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx' });
  try { return await action(); }
  finally {
    if (JSON.parse(readFileSync(path, 'utf8')).owner !== owner) throw new InputError('OPENVIKING_JOB_LOCK_CHANGED');
    rmSync(path);
  }
}

export async function initializeProject(root: string, policyPath: string, projectId?: string) {
  const client = new OpenVikingClient();
  const existing = readProject(root);
  if (existing) {
    readPolicy(root, existing.evolution_policy);
    const folder = join(root, '.agent-memory', 'openviking', 'jobs', 'init-' + existing.project_id);
    if (existsSync(join(folder, 'manifest.json')) && !existsSync(join(folder, 'published.json'))) {
      return locked(folder, async () => {
        const manifest: ProjectManifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
        const bytes = new Map(manifest.files.map(file => [file.path, readFileSync(join(folder, 'assets', file.path))]));
        await ensureDirectory(client, existing.root_uri);
        const head = await publishRelease(client, existing, manifest, bytes, null);
        const consumed = JSON.parse(readFileSync(join(folder, 'knowledge.json'), 'utf8'));
        acknowledgeKnowledge(root, consumed.wiki, consumed.memory);
        saveJob(join(folder, 'published.json'), head);
        saveJob(join(root, '.agent-memory', 'openviking', 'materialized.json'), { release_id: sha256(manifestBytes(manifest)), files: manifest.files.filter(file => file.path.startsWith('skills/')) });
        return { project: existing, head, existing: true, recovered: true };
      });
    }
    const { head } = await readProjectHead(client, existing);
    return { project: existing, head, existing: true };
  }
  const base = workflowHead(root);
  assertManagedClean(root);
  const policy = readPolicy(root, policyPath);
  for (const path of [policyPath, ...policy.targets.flatMap(target => [target.runner, target.scenarios])]) {
    gitBytes(root, ['ls-files', '--error-unmatch', '--', workflowPath(path)]);
    if (gitText(root, ['status', '--porcelain', '--', path])) throw new InputError('OPENVIKING_POLICY_NOT_COMMITTED');
  }
  const repositories = [...new Set(readWikiPages(root, true).flatMap(page => page.entry?.repositories ?? []))];
  if (!projectId && repositories.length > 1) throw new InputError('OPENVIKING_PROJECT_ID_REQUIRED');
  const health = await client.health();
  const id = projectId ?? repositories[0] ?? randomUUID();
  const project: OpenVikingProject = { schema_version: 'evolve-openviking-project/1.0', project_id: id,
    account_id: health.account_id, user_id: health.user_id, root_uri: privateProjectUri(health.user_id, id),
    evolution_policy: workflowPath(policyPath), enabled: true, failure_policy: 'local' };
  const folder = join(root, '.agent-memory', 'openviking', 'jobs', 'init-' + id);
  return locked(folder, async () => {
    const wiki = exportWiki(root);
    const memory = exportMemory(root);
    const installed = installSkills(root, []);
    const added: AssetFile[] = [];
    const bodies = new Map<string, Buffer>();
    const walk = (path: string) => {
      for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
        const name = path + '/' + item.name;
        if (item.isDirectory()) walk(name);
        else if (item.isFile()) {
          const body = readFileSync(join(root, name));
          added.push(fileRecord(name, body, lstatSync(join(root, name)).mode & 0o111 ? '100755' : '100644')); bodies.set(name, body);
        } else throw new InputError('OPENVIKING_UNSUPPORTED_GIT_MODE');
      }
    };
    for (const name of installed.installed) walk('skills/' + name);
    const descriptor = Buffer.from(JSON.stringify(project, null, 2) + '\n');
    added.push(fileRecord('.evolve/openviking.json', descriptor)); bodies.set('.evolve/openviking.json', descriptor);
    const commit = createAssetCommit(root, base, added, bodies, [], 'chore: 建立 OpenViking 项目资产基线');
    // 新安装包属于本次操作；仅移除逐字节未变的临时副本，让 Git 安全地创建跟踪文件。
    for (const file of added.filter(file => file.path.startsWith('skills/'))) {
      if (!readFileSync(join(root, file.path)).equals(bodies.get(file.path)!)) throw new InputError('OPENVIKING_LOCAL_CHANGED');
      rmSync(join(root, file.path));
    }
    applyAssetCommit(root, base, commit);
    const skills = skillAssets(root, commit);
    for (const [path, body] of [...wiki.bodies, ...memory.bodies]) skills.bytes.set(path, body);
    const manifest: ProjectManifest = {
      schema_version: 'evolve-project-release/1.0', project_id: id, account_id: project.account_id, user_id: project.user_id,
      parent: null, created_at: new Date().toISOString(), source_commit: commit, cli_version: cliVersion,
      upstream: { cli_version: cliVersion, skills_sha256: sha256(stableJson(skills.files)) },
      files: [...skills.files, ...[...wiki.bodies, ...memory.bodies].map(([path, body]) => fileRecord(path, body))], wiki: wiki.wiki, memory: memory.memory,
      verification: { kind: 'bootstrap', session_id: null, replay_ids: [], validation_id: null },
    };
    for (const [path, body] of skills.bytes) {
      const file = join(folder, 'assets', path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body);
    }
    saveJob(join(folder, 'knowledge.json'), { wiki: wiki.consumed, memory: memory.consumed });
    saveJob(join(folder, 'manifest.json'), manifest);
    await ensureDirectory(client, project.root_uri);
    const head = await publishRelease(client, project, manifest, skills.bytes, null);
    acknowledgeKnowledge(root, wiki.consumed, memory.consumed);
    saveJob(join(folder, 'published.json'), head);
    saveJob(join(root, '.agent-memory', 'openviking', 'materialized.json'), { release_id: head.release_id, files: skills.files });
    return { project, head, existing: false, skill_commit: commit };
  });
}

function sameAsset(a: AssetFile | undefined, b: AssetFile | undefined) {
  return a?.mode === b?.mode && a?.size === b?.size && a?.sha256 === b?.sha256;
}

async function checkLocalAssetBaseline(root: string, base: string, manifest: ProjectManifest, previous: AssetFile[] | undefined,
  client: OpenVikingClient, project: OpenVikingProject) {
  const local = new Map<string, AssetFile>();
  for (const record of gitBytes(root, ['ls-tree', '-r', '-z', base, '--', 'skills/']).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(record);
    if (!match) throw new InputError('OPENVIKING_UNSUPPORTED_GIT_MODE');
    const path = match[3];
    local.set(path, fileRecord(path, gitBytes(root, ['cat-file', 'blob', match[2]]), match[1] as AssetFile['mode']));
  }
  const managed = manifest.files.filter(file => file.path.startsWith('skills/'));
  let baseline = previous;
  if (baseline === undefined) {
    let ancestor = manifest;
    const seen = new Set<string>();
    while (true) {
      const files = ancestor.files.filter(file => file.path.startsWith('skills/'));
      const byPath = new Map(files.map(file => [file.path, file]));
      const packages = new Set([...managed, ...files].map(file => file.path.split('/')[1]));
      if ([...local.values()].every(file => !packages.has(file.path.split('/')[1]) || sameAsset(file, byPath.get(file.path)))) {
        baseline = files; break;
      }
      if (!ancestor.parent) throw new InputError('OPENVIKING_LOCAL_ASSET_CONFLICT');
      if (seen.has(ancestor.parent)) throw new InputError('OPENVIKING_RELEASE_CYCLE');
      seen.add(ancestor.parent);
      ancestor = await loadRelease(client, project, ancestor.parent);
    }
  }
  const old = new Map(baseline.map(file => [file.path, file]));
  const wanted = new Map(managed.map(file => [file.path, file]));
  const removed = baseline.filter(file => !wanted.has(file.path)).map(file => file.path);
  for (const path of new Set([...wanted.keys(), ...removed])) {
    const current = local.get(path);
    if (previous === undefined && !current || sameAsset(current, old.get(path)) || sameAsset(current, wanted.get(path))) continue;
    throw new InputError('OPENVIKING_LOCAL_ASSET_CONFLICT: ' + path);
  }
  return removed;
}

interface PrepareJob { base: string; release_id: string; initial_wiki: Record<string, string>; skill_commit?: string }
export async function prepareSession(root: string, store: WorkflowStore, id: string, change: Mutation) {
  workflowId(id, 'Session ID');
  const project = readProject(root);
  if (!project) throw new InputError('OPENVIKING_PROJECT_REQUIRED');
  const session = store.status(id);
  const assets = session.openviking;
  if (!assets || assets.project_id !== project.project_id) throw new InputError('OPENVIKING_BINDING_MISMATCH');
  if (assets.phase === 'ready') return store.bindAssets(id, { release_id: assets.release_id, manifest_sha256: assets.manifest_sha256, skill_commit: assets.skill_commit! }, change);
  const folder = join(root, '.agent-memory', 'openviking', 'jobs', id);
  return locked(folder, async () => {
    const path = join(folder, 'prepare.json');
    const job: PrepareJob = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
      : { base: workflowHead(root), release_id: assets.release_id, initial_wiki: sourceWikiHashes(root) };
    if (job.release_id !== assets.release_id) throw new InputError('OPENVIKING_BINDING_MISMATCH');
    saveJob(path, job);
    const client = new OpenVikingClient();
    await client.identity(project);
    const manifest = await loadRelease(client, project, assets.release_id);
    const cache = await cacheRelease(root, client, project, assets.release_id, manifest);
    const managed = manifest.files.filter(file => file.path.startsWith('skills/'));
    const materializedPath = join(root, '.agent-memory', 'openviking', 'materialized.json');
    const previous: AssetFile[] | undefined = existsSync(materializedPath) ? JSON.parse(readFileSync(materializedPath, 'utf8')).files : undefined;
    const bytes = new Map(managed.map(file => [file.path, readFileSync(join(cache, 'assets', file.path))]));
    if (!job.skill_commit) {
      assertManagedClean(root);
      if (workflowHead(root) !== job.base) throw new InputError('OPENVIKING_LOCAL_ADVANCED');
      const removed = await checkLocalAssetBaseline(root, job.base, manifest, previous, client, project);
      job.skill_commit = createAssetCommit(root, job.base, managed, bytes, removed, 'chore: 同步 OpenViking 项目资产 ' + assets.release_id.slice(0, 12));
      saveJob(path, job);
    }
    for (const step of session.steps) if (step.command) bindWorkflowSkill(root, step.command, job.skill_commit);
    applyAssetCommit(root, job.base, job.skill_commit);
    const bound = store.bindAssets(id, { release_id: assets.release_id, manifest_sha256: assets.manifest_sha256, skill_commit: job.skill_commit }, change);
    saveJob(materializedPath, { release_id: assets.release_id, files: managed });
    return bound;
  });
}

interface FinishJob {
  policy_sha256?: string;
  resolved_against?: string;
  created_at: string; base_release: string; base_commit: string; local_head: string;
  review?: { session: string; evidence: number; runs: ReviewedRun[]; signals: SkillSignal[] };
  candidate_commit?: string; replay_ids: string[]; validation_id?: string;
  manifest?: ProjectManifest; expected_head?: string;
  wiki_consumed?: WikiPublicationChanges;
  memory_consumed?: Record<string, MemorySelection>;
  published_release?: string;
}

export async function finishSession(root: string, store: WorkflowStore, id: string, change: Mutation, candidateCommit?: string) {
  const session = store.status(id);
  const assets = session.openviking;
  if (!assets || assets.phase !== 'ready' || !assets.skill_commit || session.status !== 'completed') throw new InputError('OPENVIKING_SESSION_NOT_COMPLETED');
  const project = readProject(root);
  if (!project || project.project_id !== assets.project_id) throw new InputError('OPENVIKING_BINDING_MISMATCH');
  if (['no_change', 'published'].includes(assets.publication?.state ?? '')) return { session_id: id, orchestration_revision: session.revision, openviking: assets, replayed: true };
  const folder = join(root, '.agent-memory', 'openviking', 'jobs', workflowId(id, 'Session ID'));
  return locked(folder, async () => {
    const started = store.recordAssetPublication(id, { state: 'running' }, change);
    const fence = { ...change, revision: started.orchestration_revision, requestId: undefined };
    const path = join(folder, 'finish.json');
    const job: FinishJob = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
      created_at: new Date().toISOString(), base_release: assets.release_id, base_commit: assets.skill_commit!, local_head: workflowHead(root), replay_ids: [],
    };
    saveJob(path, job);
    try {
      if (project.enabled === false) return store.recordAssetPublication(id, { state: 'failed', error: 'OPENVIKING_DISABLED' }, fence);
      assertManagedClean(root);
      const client = new OpenVikingClient();
      await client.identity(project);
      if (job.manifest && job.expected_head) {
        const release = sha256(manifestBytes(job.manifest));
        const latest = await readProjectHead(client, project);
        if (await releaseIsAncestor(client, project, release, latest.head.release_id)) {
          await loadRelease(client, project, release);
          acknowledgeKnowledge(root, job.wiki_consumed ?? {}, job.memory_consumed ?? {});
          return { ...store.recordAssetPublication(id, { state: 'published', release_id: release }, fence), current_head: latest.head, published_release: release };
        }
      }
      const base = await loadRelease(client, project, job.base_release);
      const cache = await cacheRelease(root, client, project, job.base_release, base);
      const prepare: PrepareJob = JSON.parse(readFileSync(join(folder, 'prepare.json'), 'utf8'));
      const baseBytes = new Map<string, Buffer>();
      for (const file of base.files) baseBytes.set(file.path, file.path.startsWith('memory/')
        ? await downloadAsset(client, project, file) : readFileSync(join(cache, 'assets', file.path)));
      if (!job.review) {
        job.review = await reviewSession(root, id, { model: () => createModelClient(root) }); saveJob(path, job);
      }
      const policy = readPolicy(root, project.evolution_policy);
      for (const path of [project.evolution_policy, ...policy.targets.flatMap(target => [target.runner, target.scenarios])]) {
        gitBytes(root, ['ls-files', '--error-unmatch', '--', path]);
        if (gitText(root, ['status', '--porcelain', '--', path])) throw new InputError('OPENVIKING_POLICY_NOT_COMMITTED');
      }
      const policyHash = sha256(stableJson([project.evolution_policy, ...policy.targets.flatMap(target => [target.runner, target.scenarios])]
        .map(path => [path, sha256(readFileSync(join(root, path)))])));
      if (job.policy_sha256 && job.policy_sha256 !== policyHash) throw new InputError('OPENVIKING_POLICY_CHANGED');
      job.policy_sha256 = policyHash; saveJob(path, job);
      const signals = job.review.signals.filter(signal => ['correction', 'error', 'retry', 'verified_fix', 'workflow_issue'].includes(signal.kind));
      const targetSignals = new Map<string, SkillSignal[]>();
      for (const signal of signals) {
        const runs = job.review.runs.filter(run => signal.runIds.includes(run.id) && run.skillRef && run.skillReads?.files.some(file => file.path === run.skillRef!.entry));
        const sources = new Set(runs.flatMap(run => [run.source, run.skillReads?.source, run.knowledgeReads?.source, run.retryOf ? run.source + ':retry' : undefined]).filter(Boolean));
        if (!runs.length || signal.sources.some(source => !sources.has(source))) throw new InputError('OPENVIKING_SIGNAL_SOURCE_INVALID');
        for (const run of runs) {
          const entry = `${run.skillRef!.package_path}/${run.skillRef!.entry}`;
          if (!policy.targets.some(target => target.entry === entry)) throw new InputError('OPENVIKING_EVOLUTION_TARGET_MISSING: ' + entry);
          targetSignals.set(entry, [...targetSignals.get(entry) ?? [], signal]);
        }
      }
      const knowledgePath = join(folder, 'knowledge-input.json');
      if (!existsSync(knowledgePath)) {
        const exportedWiki = exportWiki(root, base, prepare.initial_wiki);
        const exportedMemory = exportMemory(root, base);
        saveJob(knowledgePath, { wiki: exportedWiki.wiki, memory: exportedMemory.memory,
          wiki_consumed: exportedWiki.consumed, memory_consumed: exportedMemory.consumed,
          bodies: [...exportedWiki.bodies, ...exportedMemory.bodies].map(([path, body]) => [path, body.toString('base64')]) });
      }
      const input: { wiki: ProjectManifest['wiki']; memory: ProjectManifest['memory']; wiki_consumed: WikiPublicationChanges;
        memory_consumed: Record<string, MemorySelection>; bodies: Array<[string, string]> } = JSON.parse(readFileSync(knowledgePath, 'utf8'));
      const wiki = { wiki: input.wiki, consumed: input.wiki_consumed,
        bodies: new Map(input.bodies.filter(([path]) => path.startsWith('wiki/')).map(([path, body]) => [path, Buffer.from(body, 'base64')])) };
      const memory = { memory: input.memory, consumed: input.memory_consumed,
        bodies: new Map(input.bodies.filter(([path]) => path.startsWith('memory/')).map(([path, body]) => [path, Buffer.from(body, 'base64')])) };
      job.wiki_consumed ??= wiki.consumed; job.memory_consumed ??= memory.consumed;
      const knowledgeChanged = [...wiki.bodies, ...memory.bodies].some(([path, body]) => sha256(body) !== base.files.find(file => file.path === path)?.sha256) ||
        stableJson(wiki.wiki) !== stableJson(base.wiki) || stableJson(memory.memory) !== stableJson(base.memory);
      if (!targetSignals.size && !knowledgeChanged && !job.manifest) {
        acknowledgeKnowledge(root, wiki.consumed, memory.consumed);
        return store.recordAssetPublication(id, { state: 'no_change' }, fence);
      }
      const snapshot = await freezeKnowledge(join(folder, 'knowledge'), cache, client, project, base);
      if (!job.candidate_commit) {
        const allowedHeads = new Set([job.local_head]);
        for (const target of policy.targets.filter(target => targetSignals.has(target.entry))) {
          const stateFile = join(folder, sha256(target.entry) + '-evolution', 'state.json');
          if (existsSync(stateFile)) {
            const state = JSON.parse(readFileSync(stateFile, 'utf8'));
            for (const round of state.rounds ?? []) if (round.replay) allowedHeads.add(readSkillReplayReceipt(root, round.replay).candidate);
          }
        }
        if (!allowedHeads.has(workflowHead(root))) throw new InputError('OPENVIKING_LOCAL_ADVANCED');
        const pinned = skillAssets(root, job.base_commit);
        const current = skillAssets(root, job.local_head);
        if (stableJson(pinned.files) !== stableJson(current.files)) throw new InputError('OPENVIKING_UNVERIFIED_SKILL_CHANGES');
        for (const target of policy.targets.filter(target => targetSignals.has(target.entry))) {
          const review = { ...job.review, signals: targetSignals.get(target.entry) };
          const reviewPath = join(folder, sha256(target.entry) + '-review.json');
          saveJob(reviewPath, review);
          const outputDir = join(folder, sha256(target.entry) + '-evolution');
          const statePath = join(outputDir, 'state.json');
          let state;
          if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8'));
          else {
            const driver = join(cache, 'assets', 'skills', 'workflow-evolve', 'scripts', 'evolve-loop.mjs');
            const cli = join(bundle, 'dist', 'workflow-cli.js');
            const output = execFileSync(process.execPath, [driver, '--skill', target.entry, '--scenarios', target.scenarios, '--runner', target.runner,
              '--memory-cli', cli, '--iterations', '1', '--auto', '--review', reviewPath, '--output-dir', outputDir], {
              cwd: root, encoding: 'utf8', windowsHide: true, timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024,
              env: { ...process.env, EVOLVE_CLI: cli, AGENT_MEMORY_CLI: cli,
                EVOLVE_KNOWLEDGE_SNAPSHOT: snapshot.path, AGENT_MEMORY_DB: join(snapshot.path, 'memory.db') }, stdio: ['pipe', 'pipe', 'pipe'],
            });
            state = JSON.parse(output);
          }
          if (state.status !== 'completed' || state.rounds.some((round: { status: string }) => !['applied', 'converged', 'no_signals'].includes(round.status))) {
            throw new InputError('OPENVIKING_EVOLUTION_REJECTED');
          }
          for (const round of state.rounds) if (round.replay) {
            const receipt = readSkillReplayReceipt(root, round.replay);
            if (!receipt.sources.every(source => review.signals!.some(signal => signal.sources.includes(source)))) throw new InputError('OPENVIKING_SIGNAL_SOURCE_INVALID');
            if (!job.replay_ids.includes(receipt.id)) job.replay_ids.push(receipt.id);
          }
          if (frozenKnowledgeHash(snapshot.path) !== snapshot.hash) throw new InputError('OPENVIKING_FROZEN_KNOWLEDGE_CHANGED');
          saveJob(path, job);
        }
        job.candidate_commit = workflowHead(root); saveJob(path, job);
      }
      if (candidateCommit) {
        if (assets.publication?.state !== 'conflict' || !existsSync(join(folder, 'theirs.json'))) throw new InputError('OPENVIKING_RESOLUTION_NOT_EXPECTED');
        const changed = gitText(root, ['diff', '--name-only', job.candidate_commit, candidateCommit]).split(/\r?\n/).filter(Boolean);
        if (changed.some(path => !path.startsWith('skills/'))) throw new InputError('OPENVIKING_CANDIDATE_UNMANAGED_CHANGES');
        const theirs: ProjectManifest = JSON.parse(readFileSync(join(folder, 'theirs.json'), 'utf8'));
        job.resolved_against = sha256(manifestBytes(theirs));
        job.candidate_commit = candidateCommit; delete job.manifest; saveJob(path, job);
      }
      const candidate = skillAssets(root, job.candidate_commit);
      const baseSkills = base.files.filter(file => file.path.startsWith('skills/'));
      const changedSkillPaths = [...new Set([...baseSkills, ...candidate.files].map(file => file.path))].filter(path =>
        stableJson(baseSkills.find(file => file.path === path)) !== stableJson(candidate.files.find(file => file.path === path)));
      const affected = policy.targets.filter(target => changedSkillPaths.some(path => path.startsWith(dirname(target.entry).replaceAll('\\', '/') + '/')));
      if (changedSkillPaths.some(path => !affected.some(target => path.startsWith(dirname(target.entry).replaceAll('\\', '/') + '/')))) {
        throw new InputError('OPENVIKING_EVOLUTION_TARGET_MISSING');
      }
      if (affected.length && !job.replay_ids.length) throw new InputError('OPENVIKING_REPLAY_REQUIRED');
      if (!changedSkillPaths.length && !knowledgeChanged && !job.manifest) {
        acknowledgeKnowledge(root, wiki.consumed, memory.consumed);
        return store.recordAssetPublication(id, { state: 'no_change' }, fence);
      }
      let bytes = new Map(baseBytes);
      for (const path of [...bytes.keys()]) if (path.startsWith('skills/') || !wiki.wiki.some(item => item.path === path) && !memory.memory.some(item => item.path === path)) bytes.delete(path);
      for (const [path, body] of [...candidate.bytes, ...wiki.bodies, ...memory.bodies]) bytes.set(path, body);
      if (job.manifest) bytes = new Map(job.manifest.files.map(file => [file.path, readFileSync(join(folder, 'candidate-assets', file.path))]));
      let manifest: ProjectManifest = job.manifest ?? { ...base, created_at: job.created_at, source_commit: job.candidate_commit, parent: job.resolved_against ?? job.base_release,
        cli_version: cliVersion, files: [...candidate.files, ...[...bytes].filter(([path]) => !path.startsWith('skills/')).map(([path, body]) => fileRecord(path, body))],
        wiki: wiki.wiki, memory: memory.memory,
        verification: { kind: affected.length ? 'evolved' : 'knowledge', session_id: id, replay_ids: job.replay_ids, validation_id: null } };
      for (let competition = 0; competition < 2; competition++) {
        const latest = await readProjectHead(client, project);
        if (latest.head.release_id !== manifest.parent) {
          const theirs = await loadRelease(client, project, latest.head.release_id);
          const theirBytes = new Map<string, Buffer>();
          for (const file of theirs.files) theirBytes.set(file.path, await downloadAsset(client, project, file));
          saveJob(join(folder, 'base.json'), base); saveJob(join(folder, 'ours.json'), manifest); saveJob(join(folder, 'theirs.json'), theirs);
          for (const [path, body] of bytes) {
            const file = join(folder, 'conflict-assets', path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body);
          }
          const merged = mergeProjectAssets(base, manifest, theirs, baseBytes, bytes, theirBytes, join(folder, 'merge-' + competition));
          manifest = { ...merged.manifest, parent: latest.head.release_id }; bytes = merged.bytes;
          const files = manifest.files.filter(file => file.path.startsWith('skills/'));
          const current = skillAssets(root, workflowHead(root));
          const removed = current.files.filter(file => !files.some(item => item.path === file.path)).map(file => file.path);
          job.candidate_commit = createAssetCommit(root, workflowHead(root), files, bytes, removed, 'chore: 合并 OpenViking 并发项目资产');
          manifest.source_commit = job.candidate_commit;
        }
        const changed = [...new Set([...base.files, ...manifest.files].filter(file => file.path.startsWith('skills/')).map(file => file.path))]
          .filter(path => stableJson(manifest.files.find(file => file.path === path)) !== stableJson(base.files.find(file => file.path === path))).map(path => ({ path }));
        const targets = policy.targets.filter(target => changed.some(file => file.path.startsWith(dirname(target.entry).replaceAll('\\', '/') + '/')));
        if (changed.some(file => !targets.some(target => file.path.startsWith(dirname(target.entry).replaceAll('\\', '/') + '/')))) throw new InputError('OPENVIKING_EVOLUTION_TARGET_MISSING');
        const validation = verifySkillCommit(root, job.candidate_commit!, targets, snapshot.path);
        job.validation_id = validation.id; manifest.verification.validation_id = validation.id;
        job.manifest = manifest; job.expected_head = latest.raw.toString('base64');
        writeFileSync(join(folder, 'manifest.bin'), manifestBytes(manifest));
        for (const [name, body] of bytes) {
          const target = join(folder, 'candidate-assets', name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body);
        }
        saveJob(path, job);
        const localHead = workflowHead(root);
        if (localHead !== job.local_head && localHead !== job.candidate_commit && !job.replay_ids.some(id => readSkillReplayReceipt(root, id).candidate === localHead)) {
          throw new InputError('OPENVIKING_LOCAL_ADVANCED');
        }
        assertManagedClean(root);
        applyAssetCommit(root, localHead, job.candidate_commit!);
        try {
          const head = await publishRelease(client, project, manifest, bytes, latest.raw);
          job.published_release = sha256(manifestBytes(manifest)); saveJob(path, job);
          acknowledgeKnowledge(root, job.wiki_consumed ?? {}, job.memory_consumed ?? {});
          return { ...store.recordAssetPublication(id, { state: 'published', release_id: job.published_release }, fence), current_head: head, published_release: job.published_release };
        } catch (error) {
          if (!(error instanceof OpenVikingError) || error.code !== 'OPENVIKING_PUBLICATION_CONFLICT' || competition === 1) throw error;
        }
      }
      throw new InputError('OPENVIKING_PUBLICATION_CONFLICT');
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('OPENVIKING_') ? error.message : 'OPENVIKING_FINISH_FAILED';
      store.recordAssetPublication(id, { state: /CONFLICT/.test(message) ? 'conflict' : 'failed', error: message }, fence);
      if (error instanceof OpenVikingError) throw error;
      throw new InputError(message, { cause: error });
    }
  });
}
