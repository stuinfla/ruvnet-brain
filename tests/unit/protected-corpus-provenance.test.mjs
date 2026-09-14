import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Same technique as tests/unit/protected-artifact-provenance.test.mjs, pointed at the corpus chain:
// execute the ACTUAL Node guard lifted out of the workflow, replacing only GitHub's read-only API.
// No shell, no credentials, no network — and no second copy of the guard to drift from the real one.
const workflow = fs.readFileSync(new URL('../../.github/workflows/protected-release.yml', import.meta.url), 'utf8');
const sha = 'c'.repeat(40);
const repo = 'stuinfla/ruvnet-brain';
const workflowPath = '.github/workflows/protected-release.yml';
const RUN_ID = 4242;
const RUN_ATTEMPT = 1;

function fixture() {
  return {
    workflow: { id: 9, path: workflowPath },
    run: {
      id: RUN_ID, workflow_id: 9, path: workflowPath, event: 'workflow_dispatch',
      run_attempt: RUN_ATTEMPT, head_sha: sha, head_branch: 'main',
      repository: { id: 5, full_name: repo }, head_repository: { id: 5, full_name: repo },
    },
    artifacts: [{
      id: 77, name: `corpus-seed-prepared-${sha}`, expired: false,
      workflow_run: { id: RUN_ID, repository_id: 5, head_repository_id: 5, head_sha: sha, head_branch: 'main' },
    }],
    env: {
      GITHUB_REPOSITORY: repo,
      CANDIDATE_SHA: sha,
      PREPARATION_RUN_ID: String(RUN_ID),
      PREPARATION_RUN_ATTEMPT: String(RUN_ATTEMPT),
      PREPARATION_ARTIFACT: `corpus-seed-prepared-${sha}`,
    },
  };
}

function guardSource() {
  const step = workflow.split("name: Resolve this run's authentic corpus preparation artifact")[1]
    ?.split('echo "artifact_id=$artifact_id"')[0];
  const body = step?.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/)?.[1];
  if (!body) throw new Error('protected-release.yml has no executable corpus provenance guard');
  return body;
}

function select(input, observed = { output: '' }) {
  const calls = [];
  let output = '';
  const api = (command, args) => {
    expect(command).toBe('gh');
    const endpoint = args[1];
    calls.push(endpoint);
    if (endpoint === `repos/${repo}/actions/workflows/protected-release.yml`) return JSON.stringify(input.workflow);
    if (endpoint === `repos/${repo}/actions/runs/${input.env.PREPARATION_RUN_ID}`) return JSON.stringify(input.detailRun || input.run);
    if (endpoint === `repos/${repo}/actions/runs/${input.env.PREPARATION_RUN_ID}/artifacts?per_page=100`) {
      return JSON.stringify({ artifacts: input.artifacts });
    }
    const detail = /^repos\/.+\/actions\/artifacts\/(\d+)$/.exec(endpoint);
    if (detail) {
      const id = Number(detail[1]);
      return JSON.stringify(input.artifactDetail || input.artifacts.find((artifact) => artifact.id === id));
    }
    throw new Error(`unexpected API endpoint: ${endpoint}`);
  };
  vm.runInNewContext(guardSource().replace(/^\s*import .*;\s*$/gm, ''), {
    execFileSync: api,
    process: {
      env: input.env,
      stdout: { write: (value) => { output += value; observed.output += value; } },
    },
  });
  return { output, calls };
}

describe('protected corpus preparation artifact provenance (ADR-086 steps 9 + 17)', () => {
  it('emits a downloadable artifact ID only after authenticating run and artifact provenance', () => {
    const result = select(fixture());
    expect(result.output).toBe('77'); // sync-version-ignore: fixture artifact ID, not a manifest version
    expect(result.calls.at(-1)).toBe(`repos/${repo}/actions/artifacts/77`);
    // Never a repository-wide artifact listing: names are not authentication, and a repo-wide search
    // would happily find a same-named artifact produced by some other run.
    expect(result.calls.some((call) => call.includes('/actions/artifacts?'))).toBe(false);
    expect(result.calls[0]).toBe(`repos/${repo}/actions/workflows/protected-release.yml`);
  });

  it.each([
    // ── wrong workflow ───────────────────────────────────────────────────────────────────────
    ['wrong workflow identity', (f) => { f.run.workflow_id = 31; }],
    ['wrong workflow path on the run', (f) => { f.run.path = '.github/workflows/untrusted.yml'; }],
    ['wrong resolved workflow path', (f) => { f.workflow.path = '.github/workflows/untrusted.yml'; }],
    // ── wrong mode / event ───────────────────────────────────────────────────────────────────
    ['schedule-triggered run', (f) => { f.run.event = 'schedule'; }],
    ['push-triggered run', (f) => { f.run.event = 'push'; }],
    // ── wrong run attempt ────────────────────────────────────────────────────────────────────
    ['stale run attempt metadata', (f) => { f.run.run_attempt = 2; }],
    ['unusable run attempt input', (f) => { f.env.PREPARATION_RUN_ATTEMPT = '0'; }],
    ['non-numeric run attempt input', (f) => { f.env.PREPARATION_RUN_ATTEMPT = 'latest'; }],
    ['substituted run identity', (f) => { f.run.id = RUN_ID + 1; }],
    ['unusable run id input', (f) => { f.env.PREPARATION_RUN_ID = '-3'; }],
    // ── wrong SHA / ref ──────────────────────────────────────────────────────────────────────
    ['wrong candidate source SHA', (f) => { f.run.head_sha = 'd'.repeat(40); }],
    ['malformed candidate source SHA input', (f) => { f.env.CANDIDATE_SHA = 'not-a-sha'; }],
    ['unprotected ref', (f) => { f.run.head_branch = 'feature/forgery'; }],
    // ── wrong repository ─────────────────────────────────────────────────────────────────────
    ['foreign repository', (f) => { f.run.repository.full_name = 'attacker/brain'; }],
    ['fork source', (f) => { f.run.head_repository.id = 6; }],
    // ── wrong artifact ───────────────────────────────────────────────────────────────────────
    ['wrong artifact name', (f) => { f.artifacts[0].name = 'release-candidate-forged'; }],
    ['artifact name the preparation job never declared', (f) => { f.env.PREPARATION_ARTIFACT = 'corpus-seed-prepared-other'; }],
    ['artifact bound to another run', (f) => { f.artifacts[0].workflow_run.id = RUN_ID + 9; }],
    ['artifact bound to another source SHA', (f) => { f.artifacts[0].workflow_run.head_sha = 'd'.repeat(40); }],
    ['artifact from a foreign repository', (f) => { f.artifacts[0].workflow_run.repository_id = 6; }],
    ['artifact from a fork', (f) => { f.artifacts[0].workflow_run.head_repository_id = 6; }],
    ['artifact from another branch', (f) => { f.artifacts[0].workflow_run.head_branch = 'release/other'; }],
    ['expired artifact', (f) => { f.artifacts[0].expired = true; }],
    ['no artifact at all', (f) => { f.artifacts = []; }],
    ['a second attempt\'s duplicate artifact', (f) => {
      f.artifacts.push({ ...structuredClone(f.artifacts[0]), id: 78 });
    }],
    ['artifact detail substitution', (f) => {
      f.artifactDetail = structuredClone(f.artifacts[0]);
      f.artifactDetail.workflow_run.id = RUN_ID + 9;
    }],
    ['run detail substitution', (f) => {
      f.detailRun = structuredClone(f.run);
      f.detailRun.head_sha = 'd'.repeat(40);
    }],
  ])('refuses %s before emitting a downloadable artifact ID', (_name, mutate) => {
    const input = fixture();
    mutate(input);
    const observed = { output: '' };
    expect(() => select(input, observed)).toThrow(/untrusted|no trusted|authentic|provenance changed/);
    // The only thing downstream consumes is stdout. Nothing may reach it on a refusal.
    expect(observed.output).toBe('');
  });

  it('is a real guard: every refusal above is load-bearing, not incidental', () => {
    // RED proof for the whole matrix in one shot — delete the trust predicate and the guard stops
    // refusing anything. If this ever passes with the predicate gone, the matrix above is theatre.
    const neutered = guardSource()
      .replace(/const trustedRun = \(run\) =>[\s\S]*?head_repository\.id === run\.repository\.id;/, 'const trustedRun = () => true;')
      .replace(/const trustedArtifact = \(artifact\) =>[\s\S]*?head_repository_id === run\.repository\.id;/, 'const trustedArtifact = () => true;')
      .replace(/^\s*import .*;\s*$/gm, '');
    const input = fixture();
    input.run.head_sha = 'd'.repeat(40);
    input.run.repository.full_name = 'attacker/brain';
    let output = '';
    vm.runInNewContext(neutered, {
      execFileSync: (command, args) => {
        const endpoint = args[1];
        if (endpoint === `repos/${repo}/actions/workflows/protected-release.yml`) return JSON.stringify(input.workflow);
        if (endpoint === `repos/${repo}/actions/runs/${RUN_ID}`) return JSON.stringify(input.run);
        if (endpoint === `repos/${repo}/actions/runs/${RUN_ID}/artifacts?per_page=100`) return JSON.stringify({ artifacts: input.artifacts });
        return JSON.stringify(input.artifacts[0]);
      },
      process: { env: input.env, stdout: { write: (value) => { output += value; } } },
    });
    expect(output, 'with the predicates removed a foreign-repository run must sail through — proving the real predicates are what refuse it')
      .toBe('77'); // sync-version-ignore: fixture artifact ID, not a manifest version
  });
});
