// Shared producers for local diagnostics, CI, and candidate qualification.
export function selectLanes(lanes, requested) {
  if (!requested.length) return lanes;
  const selected = new Set();
  const visit = (name) => {
    const lane = lanes.find((entry) => entry.name === name);
    if (!lane) throw new Error(`unknown QA lane: ${name}`);
    if (selected.has(name)) return;
    selected.add(name);
    for (const dependency of lane.dependsOn || []) visit(dependency);
  };
  requested.forEach(visit);
  return lanes.filter(({ name }) => selected.has(name));
}

export function qaLanes({ release = false, base = null, runtimeCensusArgs = [] } = {}) {
  const node = (name, script, args = [], extra = {}) => ({ name, command: process.execPath, args: [script, ...args], resource: 'static', ...extra });
  const test = (name, args) => node(name, 'node_modules/vitest/vitest.mjs', ['run', ...args], { resource: 'tests', report: 'vitest', testTargets: args.filter((arg) => !arg.startsWith('-')) });
  return [
    node('version', 'scripts/sync-version.mjs', ['--check']),
    node('convergence', 'scripts/convergence-manifest.mjs'),
    node('execution-policy', 'scripts/execution-policy.mjs', ['{"action":"delegate","description":"architecture audit","nativeHosts":["codex"]}']),
    node('architecture', 'scripts/product-integrity-contract.mjs', ['--check-source']),
    node('docs', 'scripts/doc-currency.mjs', ['--check', ...(base ? ['--changed', base] : ['--warn-drift'])]),
    node('wiring', 'scripts/wired-check.mjs', ['--check']),
    node('substitution', 'scripts/no-silent-substitution.mjs'),
    node('catalog', 'scripts/verify-model-catalog.mjs'),
    test('coverage', ['tests/unit', '--coverage']),
    node('claims-source', 'scripts/claims-verify.mjs', ['--strict', '--scope', 'source'], { dependsOn: ['coverage'], report: 'claims' }),
    test('mesh', ['tests/mesh']),
    node('plugin', 'plugin/test/run-tests.mjs', [], { resource: 'tests' }),
    ...(release ? [
      test('mutation', ['tests/mutation']),
      test('regression', ['tests/regression']),
      test('integration', ['tests/integration']),
      test('continuity', ['tests/acceptance/cross-host-project-resume.test.mjs']),
      node('claims-runtime', 'scripts/claims-verify.mjs', ['--strict', '--scope', 'runtime', ...runtimeCensusArgs], { report: 'claims' }),
    ] : []),
  ];
}

// Selection is a projection, not proof that unselected registered work ran.
export function laneSelectionInventory(registered, selected) {
  const selectedNames = new Set(selected.map(({ name }) => name));
  const omittedLanes = registered.filter(({ name }) => !selectedNames.has(name))
    .map(({ name }) => ({ name, status: 'NOT_RUN', reason: 'not selected for this QA invocation' }));
  return { registeredLanes: registered.map(({ name }) => name),
    selectedLanes: selected.map(({ name }) => name), omittedLanes,
    selectionComplete: omittedLanes.length === 0 };
}
