export const orchestrationSteps = [
  'companion', 'init', 'brainstorm', 'grill', 'blueprint', 'roadmap', 'analyze', 'plan', 'execute',
  'verify', 'test', 'auto-test', 'review', 'debug', 'retrospective',
];
export const odysseyModes = ['debug', 'improve', 'planex', 'review', 'security', 'defensive', 'ui'];

const historicalPairs: Array<readonly [string, string]> = [
  ['maestro', 'ew-orchestrate'],
  ['maestro-odyssey', 'ew-odyssey'],
  ['maestro-skill-design', 'ew-skill-design'],
  ['maestro-impeccable', 'ew-impeccable'],
  ['maestro-knowledge', 'ew-knowledge'],
  ['workflow-closeout', 'ew-knowledge'],
  ['team-swarm', 'ew-swarm'],
  ...orchestrationSteps.map(step => [step, 'ew-' + step] as const),
  ...odysseyModes.map(mode => ['odyssey-' + mode, 'ew-odyssey-' + mode] as const),
];

const historical = new Map(historicalPairs.map(([old, current]) => [current, old]));

const aliases = new Map<string, string>([
  ...historicalPairs,
  ['orchestrate', 'ew-orchestrate'],
  ['odyssey', 'ew-odyssey'],
  ['swarm', 'ew-swarm'],
  ['skill-design', 'ew-skill-design'],
  ['impeccable', 'ew-impeccable'],
  ['knowledge', 'ew-knowledge'],
  ...orchestrationSteps.map(step => ['maestro-' + step, 'ew-' + step] as const),
]);

export function workflowName(name: string) {
  return aliases.get(name) ?? name;
}

export function historicalWorkflowName(name: string) {
  return historical.get(name);
}
