import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const CHECKOUT = path.resolve(import.meta.dirname, '../..');
const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || CHECKOUT);
const sha40 = /^[0-9a-f]{40}$/;

function read(file) {
  const full = path.join(ROOT, file);
  const draftName = path.join(ROOT, path.basename(file));
  return fs.readFileSync(fs.existsSync(full) ? full : draftName, 'utf8');
}

function workflow(file) {
  const source = read(file);
  return { source, doc: YAML.parse(source) };
}

function namedStep(file, job, name) {
  const { doc } = workflow(file);
  const steps = doc?.jobs?.[job]?.steps || [];
  const found = steps.find(candidate => candidate?.name === name);
  if (!found?.run) throw new Error(`missing executable step ${name}`);
  return found.run;
}

function step(file, name) {
  return namedStep(file, 'prepare', name);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture({ moved = false, dirty = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-source-')));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(work, 'source.txt'), 'first\n');
  git(work, 'add', 'source.txt');
  git(work, 'commit', '-m', 'fixture');
  const expected = git(work, 'rev-parse', 'HEAD');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', 'origin', 'HEAD:refs/heads/main');
  git(work, 'push', 'origin', 'HEAD:refs/heads/release/fixture');
  if (moved) {
    fs.writeFileSync(path.join(work, 'source.txt'), 'second\n');
    git(work, 'commit', '-am', 'move remote');
    git(work, 'push', 'origin', 'HEAD:refs/heads/main');
    git(work, 'reset', '--hard', expected);
  }
  if (dirty) fs.writeFileSync(path.join(work, 'untracked.txt'), 'dirty\n');
  return { root, work, expected };
}

function execute(script, cwd, env) {
  // Keep the harness itself outside the checkout: the workflow's dirty-tree assertion must see
  // only fixture state, exactly as the runner does after checkout.
  const file = path.join(path.dirname(cwd), 'step.sh');
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${script}\n`);
  fs.chmodSync(file, 0o755);
  try {
    execFileSync(file, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
    return { ok: true };
  } catch (error) {
    return { ok: false, status: error.status, stderr: String(error.stderr || ''), stdout: String(error.stdout || '') };
  }
}

describe('forwarded corpus candidate source admission', () => {
  it('uses the actual workflow source-identity shell and accepts clean main/release refs', () => {
    const script = step('.github/workflows/corpus-seed.yml', 'Require the exact clean invoking source');
    for (const ref of ['refs/heads/main', 'refs/heads/release/fixture']) {
      const f = fixture();
      const result = execute(script, f.work, {
        EXPECTED_SHA: f.expected, SOURCE_REF: ref, INVOKING_REF: ref, INVOKING_SHA: f.expected,
      });
      expect(result, `${ref}: stderr=${result.stderr} stdout=${result.stdout}`).toMatchObject({ ok: true });
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects malformed refs, invoking identity mismatches, moved refs, and dirty checkouts', () => {
    const script = step('.github/workflows/corpus-seed.yml', 'Require the exact clean invoking source');
    const cases = [
      { SOURCE_REF: 'refs/tags/v4.3.26', INVOKING_REF: 'refs/tags/v4.3.26' },
      { SOURCE_REF: 'refs/heads/other', INVOKING_REF: 'refs/heads/main' },
      { SOURCE_REF: 'refs/heads/main', INVOKING_REF: 'refs/heads/other' },
      { SOURCE_REF: 'refs/heads/main', INVOKING_REF: 'refs/heads/main', INVOKING_SHA: 'b'.repeat(40) },
    ];
    for (const overrides of cases) {
      const f = fixture();
      expect(execute(script, f.work, { EXPECTED_SHA: f.expected, INVOKING_SHA: f.expected,
        SOURCE_REF: 'refs/heads/main', INVOKING_REF: 'refs/heads/main', ...overrides }).ok).toBe(false);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
    for (const options of [{ moved: true }, { dirty: true }]) {
      const f = fixture(options);
      expect(execute(script, f.work, { EXPECTED_SHA: f.expected, SOURCE_REF: 'refs/heads/main',
        INVOKING_REF: 'refs/heads/main', INVOKING_SHA: f.expected }).ok).toBe(false);
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed candidate SHA in the workflow guard', () => {
    const script = step('.github/workflows/corpus-seed.yml', 'Reject ambiguous seed or source identities');
    const f = fixture();
    expect(execute(script, f.work, {
      EXPECTED_SHA: 'not-a-sha', SOURCE_REF: 'refs/heads/main', INVOKING_REF: 'refs/heads/main', INVOKING_SHA: f.expected,
    }).ok).toBe(false);
    expect(sha40.test(f.expected)).toBe(true);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe('candidate corpus workflow serialization', () => {
  it('parses every release shell step, including nested heredocs', () => {
    for (const name of ['corpus-seed', 'ci', 'release-candidate-preflight', 'protected-release']) {
      const { doc } = workflow(`.github/workflows/${name}.yml`);
      for (const job of Object.values(doc.jobs)) {
        for (const item of job.steps || []) {
          if (!item.run || item.shell === 'pwsh') continue;
          expect(() => execFileSync('bash', ['-n'], { input: item.run, stdio: ['pipe', 'pipe', 'pipe'] }),
            `${name}: ${item.name || item.id || 'unnamed shell step'}`).not.toThrow();
        }
      }
    }
  });

  it('serializes corpus preparation before ci with exact source and prepared inputs', () => {
    const { doc } = workflow('.github/workflows/release-candidate-preflight.yml');
    const jobs = doc.jobs;
    expect(jobs['corpus-prepare']).toMatchObject({
      uses: './.github/workflows/corpus-seed.yml',
      with: { candidate_sha: '${{ github.sha }}', source_ref: '${{ github.ref }}' },
    });
    expect(jobs.ci.needs).toBe('corpus-prepare');
    for (const field of ['artifact_name', 'artifact_id', 'artifact_digest', 'archive_sha256',
      'receipt_sha256', 'accuracy_sha256', 'recall_sha256']) {
      expect(jobs.ci.with[`prepared_${field}`]).toBe('${{ needs.corpus-prepare.outputs.' + field + ' }}');
    }
    const ci = workflow('.github/workflows/ci.yml').doc;
    for (const field of ['prepared_artifact_name', 'prepared_artifact_id', 'prepared_artifact_digest',
      'prepared_archive_sha256', 'prepared_receipt_sha256', 'prepared_accuracy_sha256', 'prepared_recall_sha256']) {
      expect(ci.on.workflow_call.inputs[field]).toMatchObject({ required: true, type: 'string' });
    }
  });

  it('exposes producer outputs and immutable upload identity without publication authority', () => {
    const { source, doc } = workflow('.github/workflows/corpus-seed.yml');
    expect(doc.on.workflow_call.inputs.source_ref).toMatchObject({ type: 'string', default: 'refs/heads/main' });
    expect(doc.on.workflow_call.outputs).toMatchObject({ recall_sha256: {}, artifact_id: {}, artifact_digest: {} });
    expect(doc.jobs.prepare.outputs).toMatchObject({
      recall_sha256: '${{ steps.seal.outputs.recall_sha256 }}',
      artifact_id: '${{ steps.upload.outputs.artifact-id }}',
      artifact_digest: '${{ steps.upload.outputs.artifact-digest }}',
    });
    const upload = doc.jobs.prepare.steps.find(candidate => candidate.id === 'upload');
    expect(upload?.uses).toBe('actions/upload-artifact@v4');
    expect(source).toContain('RUVNET_MEASUREMENT_SIGNING_KEY');
    expect(source).toContain('RUVNET_GISTS_TOKEN');
    expect(doc.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(source).not.toMatch(/npm publish|npm dist-tag|RUVNET_SIGNING_KEY|environment:/);
  });

  it('binds all four prepared corpus evidence files into the candidate payload and both upload paths', () => {
    const ci = workflow('.github/workflows/ci.yml').doc;
    const payloadStep = ci.jobs['release-qe'].steps.find(candidate => candidate.name === 'Persist the canonical candidate payload manifest');
    const members = String(payloadStep?.run || '').match(/--member "([^=]+)=([^"\n]+)"/g) || [];
    const memberNames = new Set(members.map(member => member.match(/--member "([^=]+)=/)[1]));
    for (const name of ['corpus-receipt', 'corpus-accuracy', 'corpus-recall', 'corpus-baseline']) {
      expect(memberNames, name).toContain(name);
    }
    const protectedWorkflow = workflow('.github/workflows/protected-release.yml').doc;
    const seal = protectedWorkflow.jobs['seal-payload'].steps.find(candidate => candidate.name === "Persist this run's signed payload");
    const publisher = protectedWorkflow.jobs['seal-payload'].steps.find(candidate => candidate.name === "Hand the verified payload to this run's publisher");
    for (const upload of [seal, publisher]) {
      const paths = String(upload?.with?.path || '');
      for (const file of ['corpus-receipt.json', 'ruvnet-brain.zip.accuracy.json',
        'ruvnet-brain.zip.recall.json', 'baseline-observation-receipt.json']) {
        expect(paths, `${upload?.with?.name}: ${file}`).toContain(`release-evidence/${file}`);
      }
    }
  });
});

describe('prepared corpus artifact identity admission', () => {
  function executeIdentity(run, artifact, overrides = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-artifact-')));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const artifactFile = path.join(root, 'artifact.json');
    fs.writeFileSync(artifactFile, JSON.stringify(artifact));
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\ncat "$FAKE_ARTIFACT_FILE"\n');
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    const script = path.join(root, 'identity.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash\n${run}\n`);
    fs.chmodSync(script, 0o755);
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root,
      GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '55', EXPECTED_SHA: 'a'.repeat(40),
      PREPARED_ID: '123', PREPARED_NAME: 'prepared-corpus', PREPARED_DIGEST: 'sha256:' + 'b'.repeat(64),
      FAKE_ARTIFACT_FILE: artifactFile, ...overrides,
    };
    try {
      execFileSync(script, { cwd: root, env, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('executes the draft identity verifier and rejects changed run/SHA/digest/expiry', () => {
    const run = namedStep('.github/workflows/ci.yml', 'release-qe', 'Authenticate the same-run prepared corpus artifact');
    const good = { id: 123, name: 'prepared-corpus', expired: false,
      workflow_run: { id: 55, head_sha: 'a'.repeat(40) }, digest: 'sha256:' + 'b'.repeat(64) };
    expect(executeIdentity(run, good)).toBe(true);
    for (const change of [
      { workflow_run: { id: 56, head_sha: 'a'.repeat(40) } },
      { workflow_run: { id: 55, head_sha: 'c'.repeat(40) } },
      { digest: 'sha256:' + 'c'.repeat(64) },
      { expired: true },
    ]) expect(executeIdentity(run, { ...good, ...change })).toBe(false);
  });
});
