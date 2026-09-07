import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const workflow = fs.readFileSync(new URL('../../.github/workflows/protected-release.yml', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const repo = 'stuinfla/ruvnet-brain';
const workflowPath = '.github/workflows/release-candidate-preflight.yml';
function fixture() {
  return {
    workflow: { id: 7, path: workflowPath },
    run: { id: 11, workflow_id: 7, path: workflowPath, status: 'completed', conclusion: 'success',
      event: 'push', head_sha: sha, head_branch: 'release/4.3.10',
      repository: { id: 3, full_name: repo }, head_repository: { id: 3, full_name: repo } },
    artifact: { id: 13, name: `release-candidate-${sha}`, expired: false,
      workflow_run: { id: 11, repository_id: 3, head_repository_id: 3, head_sha: sha, head_branch: 'release/4.3.10' } },
  };
}
// Execute the actual workflow's Node guard, replacing only GitHub's read-only API.
// No shell, executable shim, credentials, network, or platform-specific paths required.
function select(input, observed = { output: '' }) {
  const step = workflow.split('name: Restore the one successful preflight artifact for this exact SHA')[1]?.split('      - id: verify')[0];
  const body = step?.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/)?.[1];
  if (!body) throw new Error('workflow has no executable preflight provenance guard');
  const calls = [];
  let output = '';
  const api = (command, args) => {
    expect(command).toBe('gh');
    const endpoint = args[1];
    calls.push(endpoint);
    if (endpoint === `repos/${repo}/actions/workflows/release-candidate-preflight.yml`) return JSON.stringify(input.workflow);
    if (endpoint.startsWith(`repos/${repo}/actions/workflows/7/runs?`)) return JSON.stringify({ workflow_runs: [input.run] });
    if (endpoint === `repos/${repo}/actions/runs/11`) return JSON.stringify(input.run);
    if (endpoint === `repos/${repo}/actions/runs/11/artifacts?per_page=100`) return JSON.stringify({ artifacts: [input.artifact] });
    if (endpoint === `repos/${repo}/actions/artifacts/13`) return JSON.stringify(input.detail || input.artifact);
    throw new Error(`unexpected API endpoint: ${endpoint}`);
  };
  vm.runInNewContext(body.replace(/^\s*import .*;\s*$/gm, ''), {
    execFileSync: api,
    process: { env: { GITHUB_REPOSITORY: repo, CANDIDATE_SHA: sha }, stdout: { write: (value) => { output += value; observed.output += value; } } },
  });
  return { output, calls };
}

describe('protected publisher preflight artifact provenance', () => {
  it('selects the exact artifact only after authenticating its producer and detail', () => {
    const result = select(fixture());
    expect(result.output).toBe('13'); // sync-version-ignore: fixture artifact ID, not a manifest version
    expect(result.calls.at(-1)).toBe(`repos/${repo}/actions/artifacts/13`);
    expect(result.calls.some((call) => call.includes('/actions/artifacts?'))).toBe(false);
  });
  it.each([
    ['wrong workflow identity', (f) => { f.run.workflow_id = 99; }],
    ['wrong workflow path', (f) => { f.run.path = '.github/workflows/untrusted.yml'; }],
    ['wrong resolved workflow path', (f) => { f.workflow.path = '.github/workflows/untrusted.yml'; }],
    ['failed run', (f) => { f.run.conclusion = 'failure'; }],
    ['incomplete run', (f) => { f.run.status = 'in_progress'; }],
    ['pull request event', (f) => { f.run.event = 'pull_request'; }],
    ['untrusted branch', (f) => { f.run.head_branch = 'feature/forgery'; }],
    ['wrong source SHA', (f) => { f.run.head_sha = 'b'.repeat(40); }],
    ['foreign repository', (f) => { f.run.repository.full_name = 'attacker/brain'; }],
    ['fork source', (f) => { f.run.head_repository.id = 4; }],
    ['wrong artifact run', (f) => { f.artifact.workflow_run.id = 12; }],
    ['wrong artifact source SHA', (f) => { f.artifact.workflow_run.head_sha = 'b'.repeat(40); }],
    ['foreign artifact repository', (f) => { f.artifact.workflow_run.repository_id = 4; }],
    ['fork artifact source', (f) => { f.artifact.workflow_run.head_repository_id = 4; }],
    ['wrong artifact branch', (f) => { f.artifact.workflow_run.head_branch = 'release/other'; }],
    ['expired artifact', (f) => { f.artifact.expired = true; }],
    ['wrong artifact name', (f) => { f.artifact.name = 'forged'; }],
    ['artifact detail substitution', (f) => { f.detail = structuredClone(f.artifact); f.detail.workflow_run.id = 12; }],
  ])('refuses %s before emitting a downloadable artifact ID', (_, mutate) => {
    const input = fixture();
    mutate(input);
    const observed = { output: '' };
    expect(() => select(input, observed)).toThrow(/untrusted|no trusted|authentic|provenance changed/);
    expect(observed.output).toBe('');
  });
});
