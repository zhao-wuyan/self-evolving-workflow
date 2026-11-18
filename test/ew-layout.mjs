import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const project = dirname(root);
const orchestrator = join(project, 'skills', 'ew-orchestrate');
const knowledge = join(project, 'skills', 'ew-knowledge');
const steps = [
  'ew-init', 'ew-brainstorm', 'ew-grill', 'ew-blueprint', 'ew-roadmap', 'ew-analyze', 'ew-plan', 'ew-execute',
  'ew-verify', 'ew-test', 'ew-auto-test', 'ew-review', 'ew-debug', 'ew-retrospective',
];
const retiredCompanionName = ['maestro', 'companion'].join('-');
const topLevelForbidden = ['maestro', 'maestro-odyssey', 'maestro-skill-design', 'maestro-next', 'maestro-ralph', retiredCompanionName, 'team-swarm',
  'workflow-closeout', 'init', 'analyze', 'plan', 'execute', 'brainstorm', 'grill', 'blueprint', 'roadmap', 'verify', 'test', 'auto-test', 'review', 'debug', 'retrospective', ...steps];

function markdown(path) {
  assert.ok(existsSync(path), `Missing Markdown file: ${relative(project, path)}`);
  return readFileSync(path, 'utf8');
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const entry = markdown(join(orchestrator, 'SKILL.md'));
assert.match(entry, /^name: ew-orchestrate$/m);
assert.match(entry, /argument-hint:.*--goal <goal>/);
assert.match(entry, /<goal_long_chain>/);
assert.match(entry, /<companion_route>/);
assert.match(entry, /references\/goal\.md/);
assert.match(entry, /references\/companion-route\.md/);
for (const step of steps) assert.match(entry, new RegExp(`steps/${step}/SKILL\\.md`));

const companionRoute = markdown(join(orchestrator, 'references', 'companion-route.md'));
for (const marker of ['内部路由', 'ew-companion` 步骤', 'Session/Run', 'ew-analyze', 'ew-plan', 'ew-execute', 'ew-review']) {
  assert.match(companionRoute, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const knowledgeEntry = markdown(join(knowledge, 'SKILL.md'));
assert.match(knowledgeEntry, /^name: ew-knowledge$/m);
const knowledgeRoute = markdown(join(knowledge, 'references', 'knowledge-route.md'));
for (const marker of ['统一 Wiki', 'Closeout', 'mode: constraint', 'mode: reference', 'wiki/']) {
  assert.match(knowledgeRoute, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
markdown(join(knowledge, 'references', 'closeout-protocol.md'));
markdown(join(knowledge, 'references', 'wiki-maintenance.md'));
assert.equal(existsSync(join(orchestrator, 'references', 'knowledge-route.md')), false,
  'Knowledge route should not live inside ew-orchestrate');

const goal = markdown(join(orchestrator, 'references', 'goal.md'));
for (const marker of ['evolve-session/1.0', 'goal_ref', 'session complete', 'pending-tail']) assert.match(goal, new RegExp(marker));

for (const step of steps) {
  const stepEntry = markdown(join(orchestrator, 'steps', step, 'SKILL.md'));
  assert.match(stepEntry, new RegExp(`name: ${step}\\b`));
  assert.match(stepEntry, /contract_version: 2\.1/);
}
markdown(join(orchestrator, 'steps', 'ew-review', 'references', 'prepare.md'));
markdown(join(orchestrator, 'steps', 'ew-review', 'references', 'workflow.md'));

for (const packageName of topLevelForbidden) {
  assert.equal(existsSync(join(project, 'skills', packageName)), false,
    `Independent package remains: skills/${packageName}`);
}

const staleTokens = new RegExp(`maestro-next|maestro-ralph|${retiredCompanionName}|ralph-amend-goal|skills\\/(?:analyze|plan|execute)\\/`);
for (const file of [...walk(join(project, 'skills')), ...walk(join(project, 'docs'))]) {
  if (!file.endsWith('.md')) continue;
  assert.doesNotMatch(readFileSync(file, 'utf8'), staleTokens, `Stale Skill reference: ${relative(project, file)}`);
}

for (const file of walk(orchestrator)) {
  if (!file.endsWith('.md')) continue;
  assert.doesNotMatch(readFileSync(file, 'utf8'), /maestro-knowledge|maestro-knowhow|maestro-spec/,
    `Independent knowledge route remains: ${relative(project, file)}`);
}

for (const file of [orchestrator, knowledge, join(project, 'skills', 'ew-odyssey'), join(project, 'skills', 'ew-skill-design'),
  join(project, 'skills', 'ew-swarm'), join(project, 'skills', 'ew-impeccable')].flatMap(walk)) {
  if (!file.endsWith('.md')) continue;
  const directory = dirname(file);
  for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1].split('#', 1)[0];
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|@|\/)/i.test(href)) continue;
    const target = join(directory, href);
    assert.ok(statSync(target, { throwIfNoEntry: false })?.isFile(),
      `Broken local Markdown link ${relative(project, file)} -> ${href}`);
  }
}

for (const file of [...walk(join(project, 'skills')), ...walk(join(project, 'agents'))]) {
  if (!file.endsWith('.md')) continue;
  const content = readFileSync(file, 'utf8').replace(/https?:\/\/[^\s)>]+/g, '');
  assert.doesNotMatch(content,
    /(?:\bmaestro\s+(?:run|session|delegate|execution|skills|capabilities|search|load|kg|knowledge|agent-msg|plan|artifact)\b|[$/]maestro(?:\b|-[\w-]+)|mcp__maestro|~\/\.maestro)/,
    `External workflow command in ${relative(project, file)}`);
}

const requiredAgents = [
  'cli-explore-agent', 'workflow-codebase-mapper', 'workflow-external-researcher', 'workflow-research-synthesizer',
  'workflow-analyzer', 'workflow-roadmapper', 'workflow-planner', 'workflow-collab-planner', 'workflow-plan-checker',
  'workflow-executor', 'workflow-verifier', 'workflow-integration-checker', 'workflow-nyquist-auditor',
  'workflow-reviewer', 'workflow-debugger', 'team-worker',
  'impeccable-agent', 'impeccable-asset-producer', 'impeccable-documenter',
  'impeccable-finish-reviewer', 'impeccable-manual-edit-applier', 'impeccable-motion-reviewer',
];
for (const agentName of requiredAgents) {
  const agentFile = markdown(join(project, 'agents', `${agentName}.md`));
  assert.match(agentFile, new RegExp(`^name: ${agentName}$`, 'm'), `Missing name frontmatter in agents/${agentName}.md`);
  assert.match(agentFile, /^description: .+$/m, `Missing description frontmatter in agents/${agentName}.md`);
  assert.match(agentFile, /^allowed-tools:/m, `Missing allowed-tools frontmatter in agents/${agentName}.md`);
  assert.doesNotMatch(agentFile, /(?:\.workflow\/scratch\b|\bTaskList\b|\bTaskGet\b|\bTaskUpdate\b)/,
    `Stale task-board or scratch path in agents/${agentName}.md`);
}

const readme = markdown(join(project, 'README.md'));
for (const image of ['workflow-overview.png', 'workflow-skills.png', 'impeccable-skill.png']) {
  assert.ok(readme.includes(`](docs/images/${image})`), `Missing README image reference: ${image}`);
  assert.ok(statSync(join(project, 'docs', 'images', image)).isFile());
}

for (const { path } of JSON.parse(markdown(join(project, 'workflows', 'index.json')))) markdown(join(project, path));
console.log(`EW layout passed: goal mode, ${steps.join(', ')} and ew-companion are in the orchestrator package.`);
