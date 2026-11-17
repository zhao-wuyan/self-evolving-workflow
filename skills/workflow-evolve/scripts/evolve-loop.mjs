import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function has(name) { return args.includes(name); }

function required(name) {
  const value = option(name);
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

const iterations = Number(required('--iterations'));
if (!Number.isInteger(iterations) || iterations < 1) throw new Error('--iterations must be a positive integer');
const entry = resolve(root, required('--skill'));
const scenariosPath = resolve(root, required('--scenarios'));
const runner = resolve(root, option('--runner', fileURLToPath(new URL('./codex-memory-replay.mjs', import.meta.url))));
const memoryCli = resolve(root, option('--memory-cli', process.env.AGENT_MEMORY_CLI ||
  fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))));
const agy = option('--agy', 'agy');
const maxRetries = Number(option('--max-retries', '1'));
if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('--max-retries must be a non-negative integer');
const historyFlags = ['--session', '--execution', '--history', '--review'].filter(name => option(name) !== undefined);
if (historyFlags.length > 1) throw new Error('Use only one of --session, --execution, --history or --review');
if (!historyFlags.length && !has('--allow-empty-history')) {
  throw new Error('Provide --session, --execution, --history or --review. Use --allow-empty-history only for an explicitly history-free fixture.');
}
if (!existsSync(entry)) throw new Error(`Skill entry not found: ${entry}`);
if (!existsSync(scenariosPath)) throw new Error(`Scenario file not found: ${scenariosPath}`);
if (!existsSync(runner)) throw new Error(`Replay runner not found: ${runner}`);
if (!existsSync(memoryCli)) throw new Error(`Agent Memory CLI not found: ${memoryCli}`);
process.env.AGENT_MEMORY_CLI = memoryCli;
if (process.env.AGENT_MEMORY_DB) process.env.AGENT_MEMORY_DB = resolve(root, process.env.AGENT_MEMORY_DB);

const skillEntry = entry.replaceAll('\\', '/').replace(`${root.replaceAll('\\', '/')}/`, '');
if (!/^skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/.test(skillEntry)) throw new Error('--skill must point to skills/**/SKILL.md');
const workflowCli = process.env.EVOLVE_CLI || join(dirname(memoryCli), 'workflow-cli.js');
if (!existsSync(workflowCli)) throw new Error('Configure EVOLVE_CLI to the workflow-cli.js shipped with AGENT_MEMORY_CLI');
jsonCommand(process.execPath, [workflowCli, '--root', root, 'skills', 'inspect', skillEntry, '--commit', git(['rev-parse', 'HEAD'])]);
const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8'));
if (!Array.isArray(scenarios) || scenarios.length < 2 ||
    !scenarios.some(item => item.baseline === false) || !scenarios.some(item => item.baseline === true)) {
  throw new Error('--scenarios must contain at least one baseline failure and one baseline pass');
}
let scenarioSet = scenarios.map(scenario => ({ ...scenario }));

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = resolve(root, option('--output-dir', join('.agent-memory', 'evolution', timestamp)));
mkdirSync(outputDir, { recursive: true });
const statePath = join(outputDir, 'state.json');
const state = {
  schema_version: 'workflow-evolve/1.0', target: skillEntry, iterations_requested: iterations,
  max_retries: maxRetries, auto: has('--auto'), rounds: [], status: 'running',
};

function run(command, commandArgs, options = {}) {
  const output = execFileSync(command, commandArgs, {
    cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, encoding: 'utf8', windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], input: options.input, timeout: options.timeout ?? 180_000,
  });
  return output.trim();
}

function jsonCommand(command, commandArgs, options = {}) {
  const output = run(command, commandArgs, options);
  try { return JSON.parse(output); } catch (error) { throw new Error(`Expected JSON from ${command}: ${output.slice(-2000)}`, { cause: error }); }
}

function git(args) { return run('git', args); }

function runReplay(scenario, commit) {
  const output = run(process.execPath, [runner], {
    input: JSON.stringify({ id: `${scenario.id}-round-${state.rounds.length + 1}`, input: scenario.input,
      entry: skillEntry, commit }),
  });
  return JSON.parse(output);
}

function parseAgyResponse(output) {
  const clean = output.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(clean);
  const text = typeof parsed?.response === 'string' ? parsed.response
    : typeof parsed?.result === 'string' ? parsed.result
    : typeof parsed?.output === 'string' ? parsed.output : null;
  if (text === null) return parsed;
  return JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, ''));
}

function askAgy(prompt) {
  const promptPath = join(outputDir, 'agy-request-' + randomUUID() + '.txt');
  writeFileSync(promptPath, prompt);
  const result = jsonCommand(process.execPath, [workflowCli, '--root', root, 'delegate', '--to', 'agy', '--mode', 'analysis', '--prompt-file', promptPath], {
    timeout: 600_000, env: option('--agy') ? { AGY_EXECUTABLE: agy } : {},
  });
  return parseAgyResponse(result.output);
}

function validateDiscussion(value) {
  if (!value || typeof value !== 'object') throw new Error('Agy discussion must be a JSON object');
  if (typeof value.approved !== 'boolean' || !['high', 'normal', 'low'].includes(value.priority) ||
      typeof value.instruction !== 'string' || !value.instruction.trim() ||
      !Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('Agy discussion omitted approved, priority, instruction or evidence');
  }
  if (option('--review')) {
    const review = JSON.parse(readFileSync(resolve(root, option('--review')), 'utf8'));
    const sources = new Set(review.signals.flatMap(signal => signal.sources));
    if (value.evidence.some(source => !sources.has(source))) throw new Error('Agy discussion evidence is outside the current Session review');
  }
  return value;
}

function validateConfirmation(value) {
  if (!value || typeof value !== 'object' || typeof value.approved !== 'boolean' || typeof value.reason !== 'string') {
    throw new Error('Agy confirmation must include approved and reason');
  }
  return value;
}

function reviewHistory(roundDir) {
  const reviewFile = option('--review');
  if (reviewFile) {
    const review = JSON.parse(readFileSync(resolve(root, reviewFile), 'utf8'));
    if (!Array.isArray(review.runs) || !Array.isArray(review.signals)) throw new Error('Invalid serialized Session review');
    const sources = new Set(review.runs.flatMap(run => [run.source, run.skillReads?.source, run.knowledgeReads?.source, run.retryOf ? run.source + ':retry' : undefined]).filter(Boolean));
    if (review.signals.some(signal => !Array.isArray(signal.sources) || !signal.sources.length || signal.sources.some(source => !sources.has(source)))) {
      throw new Error('Session review contains unverifiable sources');
    }
    writeFileSync(join(roundDir, 'history.json'), JSON.stringify(review, null, 2) + '\n');
    return { source: reviewFile, history: review };
  }
  const session = option('--session');
  const execution = option('--execution');
  const historyFile = option('--history');
  if (historyFile) {
    const history = JSON.parse(readFileSync(resolve(root, historyFile), 'utf8'));
    writeFileSync(join(roundDir, 'history.json'), JSON.stringify(history, null, 2) + '\n');
    return { source: historyFile, history };
  }
  if (session) {
    const review = jsonCommand(process.execPath, [memoryCli, '--root', root, 'session', 'review', session]);
    writeFileSync(join(roundDir, 'history.json'), JSON.stringify(review, null, 2) + '\n');
    return { source: `session:${session}`, history: review };
  }
  if (execution) {
    const project = option('--project', 'workflow-evolve');
    const review = jsonCommand(process.execPath, [memoryCli, '--root', root, 'evolve', 'review', execution, '--project', project]);
    writeFileSync(join(roundDir, 'history.json'), JSON.stringify(review, null, 2) + '\n');
    return { source: `execution:${execution}`, history: review };
  }
  const history = { signals: [], note: 'No committed Session/Skill receipt was supplied for this round.' };
  writeFileSync(join(roundDir, 'history.json'), JSON.stringify(history, null, 2) + '\n');
  return { source: 'none', history };
}

function promptForDiscussion(roundDir, baseline, history, previous) {
  const instruction = [
    'You are the Agy discussion gate for workflow-evolve.',
    `Read the Skill entry at ${entry} and the round files in ${roundDir}.`,
    'Review the real Codex task result, memory search trace, and supplied execution history.',
    'Propose one minimal Skill instruction that fixes the attributed failure while preserving the passing scenario.',
    'Return strict JSON with fields approved, priority, instruction, when, evidence, rationale, needs_revision.',
    'approved is true only when the suggestion is evidence-backed and bounded. priority is high, normal, or low.',
    'instruction must be one concise line. evidence must be an array of source strings. Do not edit files.',
    `Previous Agy response: ${previous ? JSON.stringify(previous) : 'none'}`,
    `Baseline observations: ${JSON.stringify(baseline)}`,
    `History: ${JSON.stringify(history)}`,
  ].join('\n');
  return askAgy(instruction);
}

function promptForConfirmation(roundDir, discussion, replay) {
  return askAgy([
    'You are the final Agy confirmation gate for workflow-evolve.',
    `Read the Skill entry at ${entry} and the round files in ${roundDir}.`,
    'Confirm whether the proposed Skill change is safe to apply after the baseline/candidate replay.',
    'Return strict JSON with fields approved, reason, required_changes. approved must be false if any baseline pass regresses, the evidence is missing, or the replay is incomplete.',
    `Discussion: ${JSON.stringify(discussion)}`,
    `Replay receipt: ${JSON.stringify(replay)}`,
  ].join('\n'));
}

try {
  for (let round = 1; round <= iterations; round += 1) {
    const roundDir = join(outputDir, `round-${round}`);
    mkdirSync(roundDir, { recursive: true });
    const base = git(['rev-parse', 'HEAD']);
    const history = reviewHistory(roundDir);
    if (option('--review') && !history.history.signals.length) {
      state.rounds.push({ round, base, status: 'no_signals', history: history.source });
      break;
    }
    const baseline = scenarioSet.map(scenario => ({ id: scenario.id, expected: scenario.input?.expected,
      observation: runReplay(scenario, base) }));
    writeFileSync(join(roundDir, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
    const regressions = baseline.filter(item => scenarioSet.find(scenario => scenario.id === item.id)?.baseline && !item.observation.passed);
    if (regressions.length) {
      state.rounds.push({ round, base, status: 'regression_detected', regressions });
      break;
    }
    const unresolved = baseline.filter(item => {
      const scenario = scenarioSet.find(candidate => candidate.id === item.id);
      return scenario?.baseline === false && !item.observation.passed;
    });
    scenarioSet = scenarioSet.map(scenario => {
      const result = baseline.find(item => item.id === scenario.id);
      return result?.observation.passed ? { ...scenario, baseline: true } : scenario;
    });
    if (!unresolved.length) {
      state.rounds.push({ round, base, status: 'converged', history: 'all scenarios passed' });
      break;
    }
    let discussion;
    let attempt = 0;
    while (attempt <= maxRetries) {
      discussion = validateDiscussion(promptForDiscussion(roundDir, baseline, history.history, discussion));
      writeFileSync(join(roundDir, 'agy-discussion.json'), JSON.stringify(discussion, null, 2) + '\n');
      if (discussion.approved) break;
      attempt += 1;
    }
    if (!discussion?.approved) {
      state.rounds.push({ round, base, status: 'agy_rejected', retries: attempt, history: history.source });
      break;
    }
    const draft = jsonCommand(process.execPath, [memoryCli, '--root', root, 'evolve', 'draft', entry,
      discussion.instruction, '--priority', discussion.priority, ...(discussion.when ? ['--when', discussion.when] : []),
      ...discussion.evidence.flatMap(item => ['--evidence', item])]);
    const draftPath = join(roundDir, 'draft.json');
    writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');
    const scenarioPath = join(roundDir, 'scenarios.json');
    writeFileSync(scenarioPath, JSON.stringify(scenarioSet, null, 2) + '\n');
    const replay = jsonCommand(process.execPath, [memoryCli, '--root', root, 'evolve', 'replay', draftPath, '--runner', runner, '--scenarios', scenarioPath]);
    writeFileSync(join(roundDir, 'replay.json'), JSON.stringify(replay, null, 2) + '\n');
    const confirmation = validateConfirmation(promptForConfirmation(roundDir, discussion, replay));
    writeFileSync(join(roundDir, 'agy-confirmation.json'), JSON.stringify(confirmation, null, 2) + '\n');
    const result = { round, base, draft: draft.id, replay: replay.id, history: history.source, agy: confirmation };
    if (!confirmation.approved) {
      state.rounds.push({ ...result, status: 'confirmation_rejected' });
      break;
    }
    if (has('--auto')) {
      const applied = jsonCommand(process.execPath, [memoryCli, '--root', root, 'evolve', 'apply', replay.id]);
      let verified;
      try { verified = scenarioSet.map(scenario => ({ id: scenario.id, observation: runReplay(scenario, applied.commit) })); }
      catch (error) {
        const rollback = jsonCommand(process.execPath, [memoryCli, '--root', root, 'evolve', 'rollback', replay.id]);
        state.rounds.push({ ...result, status: 'rolled_back', applied, rollback, reason: 'Post-apply runner failed' });
        throw error;
      }
      const passed = verified.every(item => item.observation.passed);
      if (!passed) {
        jsonCommand(process.execPath, [memoryCli, '--root', root, 'evolve', 'rollback', replay.id]);
        state.rounds.push({ ...result, status: 'rolled_back', applied, verified });
        break;
      }
      state.rounds.push({ ...result, status: 'applied', applied, verified });
    } else {
      state.rounds.push({ ...result, status: 'confirmed_pending_apply' });
      break;
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  }
  state.status = 'completed';
  state.finished_at = new Date().toISOString();
  state.state_sha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const report = { output_dir: outputDir, ...state };
  const runDir = option('--run-dir', process.env.RUN_DIR);
  const reportPath = runDir ? join(runDir, 'outputs', 'evolution-report.json') : join(outputDir, 'evolution-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  const artifact = runDir ? { ...report, _meta: {
    kind: 'workflow-evolution-report', schema: 'workflow-evolution/1.0', role: 'primary', alias: 'latest-workflow-evolution',
  } } : report;
  writeFileSync(reportPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  state.status = 'failed';
  state.error = error instanceof Error ? error.message : String(error);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  throw error;
}
