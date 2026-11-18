import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [maestro, memory, root, session, transientSession, endpoint] = process.argv.slice(2);
if (!/[\\/]evolve-maestro-closeout-[a-zA-Z0-9]+$/.test(root)) throw new Error('Expected an isolated Session fixture');
const requireMaestro = createRequire(maestro);
const { Server } = requireMaestro('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = requireMaestro('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = requireMaestro('@modelcontextprotocol/sdk/types.js');
const env = { ...process.env, AGENT_MEMORY_LLM_BASE_URL: endpoint, AGENT_MEMORY_LLM_MODEL: 'fixture' };
delete env.AGENT_MEMORY_LLM_API_KEY;
const run = (cmd, args) => execFileSync(cmd, args, {
  cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const agent = (...args) => JSON.parse(run(process.execPath, [memory, '--root', root, ...args]));
const field = { type: 'string', minLength: 1 };
const sessionField = { type: 'string', enum: [session, transientSession] };
const tool = (name, description, properties, required = Object.keys(properties)) => ({
  name, description, annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
const tools = [
  tool('review_session', 'Run the Memory Session retrospective and return the evidence-linked signals.', { session: sessionField }),
  tool('read_original_skill', 'Read SKILL.md from the reviewed Run’s bound Git commit and package tree.', {
    session: sessionField, run: field,
  }),
  tool('draft_addition', 'Generate the Memory CLI draft JSON for the reviewed Skill without modifying the package.', {
    session: sessionField, run: field, instruction: field,
    priority: { type: 'string', enum: ['high', 'normal', 'low'] },
    when: field, sources: { type: 'array', items: field, minItems: 1 },
  }, ['session', 'run', 'instruction', 'priority', 'sources']),
];

const reviewed = new Map();
const opened = new Set();
function call(name, args) {
  if (![session, transientSession].includes(args.session)) throw new Error('Select a Session from the fixture.');
  if (name === 'review_session') {
    const result = agent('session', 'review', args.session);
    reviewed.set(args.session, result);
    return result;
  }
  const review = reviewed.get(args.session);
  const target = review?.runs.find(item => item.id === args.run);
  const ref = target?.skillRef;
  if (!ref || !/^skills\/[a-z0-9-]+$/.test(ref.package_path) || ref.entry !== 'SKILL.md') {
    throw new Error('Review the Session first and select a Run with a bound project Skill.');
  }
  const entry = `${ref.package_path}/${ref.entry}`;
  const key = JSON.stringify([args.session, args.run]);
  if (name === 'read_original_skill') {
    if (run('git', ['rev-parse', '--verify', `${ref.commit}:${ref.package_path}`]).trim() !== ref.tree) {
      throw new Error('The original Skill package does not match the bound tree.');
    }
    const markdown = run('git', ['show', `${ref.commit}:${entry}`]);
    const sha256 = `sha256:${createHash('sha256').update(markdown).digest('hex')}`;
    opened.add(key);
    return { ref, entry, sha256, markdown };
  }
  if (name === 'draft_addition') {
    const validSources = new Set(review.signals.flatMap(signal => signal.sources));
    if (!opened.has(key) || !Array.isArray(args.sources) || args.sources.length === 0 ||
        args.sources.some(source => !validSources.has(source))) {
      throw new Error('Read the original Skill and cite only this Session’s reviewed sources.');
    }
    if (run('git', ['rev-parse', '--verify', `HEAD:${ref.package_path}`]).trim() !== ref.tree) {
      throw new Error('The current Skill package differs from the reviewed version.');
    }
    if (typeof args.instruction !== 'string' || !args.instruction.trim() || args.instruction.trimStart().startsWith('-') ||
        !['high', 'normal', 'low'].includes(args.priority) ||
        (args.when !== undefined && (typeof args.when !== 'string' || !args.when.trim() || args.when.trimStart().startsWith('-'))) ||
        (args.priority === 'normal' && !args.when)) throw new Error('Provide a valid instruction, priority and any required trigger.');
    return agent('skill', 'draft', join(root, entry), args.instruction, '--priority', args.priority,
      ...(args.when ? ['--when', args.when] : []), ...args.sources.flatMap(source => ['--evidence', source]));
  }
  throw new Error('Unknown retrospective tool.');
}

const server = new Server({ name: 'codex-evolve-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(call(params.name, params.arguments ?? {})) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.stderr?.trim() || error.message }] };
  }
});
await server.connect(new StdioServerTransport());
