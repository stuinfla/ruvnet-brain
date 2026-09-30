import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const workflow = () => read('.github/workflows/protected-release.yml');
const seedWorkflow = () => read('.github/workflows/corpus-seed.yml');

const CODE_JOBS = ['identity', 'verified-candidate', 'seal-payload', 'publish', 'public-verification', 'finalize-public-verification'];
const CORPUS_JOBS = ['corpus-identity', 'corpus-prepare', 'corpus-no-change', 'corpus-authorize', 'corpus-publish',
  'corpus-canary', 'corpus-promote', 'corpus-terminal-outcome'];

/**
 * Comments stripped, exactly as scripts/release-authority.mjs:16-23 does before it looks for
 * publication actions. This repo has burned itself twice on prose-matching gates — wired-check v1
 * counted a comment as a caller, and the #84 guard flagged a comment that merely NAMED a variable —
 * so a forbidden-token scan here must read what the runner executes, not what the file explains.
 */
const executable = (block) => block
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** Split a workflow into `{ name: body }`. Job headers are the only keys at exactly two spaces. */
function jobBlocks(source) {
  const jobsAt = source.indexOf('\njobs:\n');
  expect(jobsAt, 'workflow must declare jobs').toBeGreaterThan(-1);
  const body = source.slice(jobsAt + '\njobs:\n'.length);
  const headers = [...body.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/gm)];
  const blocks = {};
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : body.length;
    blocks[match[1]] = body.slice(start, end);
  });
  return blocks;
}

describe('protected-release corpus chain (ADR-086 steps 9 + 17)', () => {
  it('declares exactly the two chains, with no job left ungated', () => {
    const blocks = jobBlocks(workflow());
    expect(Object.keys(blocks)).toEqual([...CODE_JOBS, ...CORPUS_JOBS]);
    for (const job of CODE_JOBS) {
      expect(blocks[job], `${job} must be skipped in corpus mode`).toContain("if: inputs.mode != 'corpus'");
    }
    for (const job of CORPUS_JOBS) {
      expect(blocks[job], `${job} must run only in corpus mode`).toContain("inputs.mode == 'corpus'");
    }
  });

  it('WRONG MODE: the corpus identity job refuses a run that is not actually corpus mode', () => {
    const blocks = jobBlocks(workflow());
    // The `if:` selects; this asserts. Belt and braces on purpose: an `if:` typo silently skips a
    // job, while a failed `test` inside it is loud.
    expect(blocks['corpus-identity']).toContain('test "$RELEASE_MODE" = corpus');
    expect(workflow()).toContain("RELEASE_MODE: ${{ inputs.mode || 'code' }}");
  });

  it('CAPABILITY BOUNDARY: no corpus job can reach npm publication', () => {
    const blocks = jobBlocks(workflow());
    for (const job of CORPUS_JOBS) {
      const block = executable(blocks[job]);
      for (const forbidden of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'registry-url', 'npm publish', 'npm dist-tag', 'id-token']) {
        expect(block, `${job} must not carry ${forbidden}`).not.toContain(forbidden);
      }
      expect(block, `${job} must never bind the npm-scoped environment`).not.toContain('Production – ruvnet-brain');
      expect(block, `${job} must never invoke the product publisher`).not.toMatch(/release\.mjs --publish/);
    }
    // The code chain binds the reviewed environment exactly once (its npm publish job); its
    // signing-only seal and finalize jobs share the corpus signing environment.
    expect(workflow().match(/environment: Production – ruvnet-brain/g)).toHaveLength(1);
    expect(workflow().match(/environment: Production – corpus/g)).toHaveLength(3);
    expect(blocks['corpus-publish']).toContain('environment: Production – corpus');
    expect(blocks['corpus-publish']).toContain('node scripts/release.mjs --corpus-seed --stage-candidate');
  });

  it('CUSTOMER CANARY: the producer cannot promote unless a clean customer install accepted the candidate', () => {
    const source = workflow();
    const blocks = jobBlocks(source);
    // No invocation anywhere can publish-and-promote in one step any more.
    expect(executable(source)).not.toContain('--promote-latest');
    // The staging publisher never moves latest; the canary sits between staging and promotion.
    expect(blocks['corpus-publish']).toContain("echo 'outcome=staged' >> \"$GITHUB_OUTPUT\"");
    const canary = blocks['corpus-canary'];
    expect(canary).toContain("needs.corpus-publish.outputs.outcome == 'staged'");
    expect(canary).toContain('needs: [corpus-identity, corpus-prepare, corpus-publish]');
    expect(canary).toContain('node scripts/corpus-canary.mjs --repo "$GITHUB_REPOSITORY" --tag "$CANDIDATE_TAG"');
    // A customer holds no secret and no environment: the canary runs with the read-only token only.
    expect(executable(canary)).not.toMatch(/secrets\.|environment:|contents: write|GH_TOKEN|GITHUB_TOKEN/);
    expect(canary).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}steps:/);
    expect(canary).toContain('name: corpus-canary-verdict-${{ github.run_id }}-${{ github.run_attempt }}');
    const promote = blocks['corpus-promote'];
    expect(promote).toContain('needs: [corpus-identity, corpus-prepare, corpus-publish, corpus-canary]');
    expect(promote).toContain("needs.corpus-canary.result == 'success'");
    expect(promote).toContain('node scripts/release.mjs --corpus-seed --promote-staged');
    expect(promote).toContain('--canary-verdict "$RUNNER_TEMP/canary-verdict/corpus-canary-verdict.json"');
    expect(promote).toContain('name: corpus-canary-verdict-${{ github.run_id }}-${{ github.run_attempt }}');
    // Promotion signs nothing: no environment, so the signing key stays confined to `Production – corpus`.
    expect(executable(promote)).not.toMatch(/environment:|RUVNET_SIGNING_KEY|secrets\./);
    expect(promote).toContain('ref: ${{ needs.corpus-identity.outputs.candidate_sha }}');
    expect(promote).toContain('merge-base --is-ancestor "$CANDIDATE_SHA" "$GITHUB_SHA"');
    const exit4 = promote.split('if [[ "$status" -eq 4 ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(exit4).toContain("echo 'outcome=superseded' >> \"$GITHUB_OUTPUT\"");
    expect(promote.indexOf('test "$status" -eq 0')).toBeLessThan(promote.indexOf("echo 'outcome=published'"));
  });

  it('TRACKED PATHS: every corpus payload lands in runner storage and the checkout stays clean', () => {
    const blocks = jobBlocks(workflow());
    const publish = blocks['corpus-publish'];
    expect(publish).toContain('"$RUNNER_TEMP/corpus-prepared.zip"');
    expect(publish).toContain('unzip -q "$RUNNER_TEMP/corpus-prepared.zip" -d "$RUNNER_TEMP/corpus-import"');
    // The known open correction: the code lane unzips into `release-evidence/` INSIDE the checkout
    // (protected-release.yml's verified-candidate job). A corpus job doing that would fail its own
    // clean-worktree assertion.
    for (const job of CORPUS_JOBS) {
      expect(executable(blocks[job]), `${job} must not import into the checkout`).not.toContain('release-evidence');
    }
    // Asserted after import, after re-verification, after signing, and on both sides of publication.
    expect((publish.match(/test -z "\$\(git status --porcelain\)"/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it('WRONG DIGEST: the publisher re-measures the archive and receipt against the sealed identities', () => {
    const publish = jobBlocks(workflow())['corpus-publish'];
    expect(publish).toContain('EXPECTED_ARCHIVE_SHA256: ${{ needs.corpus-prepare.outputs.archive_sha256 }}');
    expect(publish).toContain('EXPECTED_RECEIPT_SHA256: ${{ needs.corpus-prepare.outputs.receipt_sha256 }}');
    expect(publish).toContain('test "$archive_sha256" = "$EXPECTED_ARCHIVE_SHA256"');
    expect(publish).toContain('test "$receipt_sha256" = "$EXPECTED_RECEIPT_SHA256"');
    expect(publish).toContain('grep -Fxq "candidate_sha=$CANDIDATE_SHA" "$staged/corpus-preparation.identity"');
    // Shape and digests are not truth. The candidate is re-derived from the archive's own bytes.
    expect(publish).toContain('node scripts/corpus-candidate.mjs --verify');
  });

  it('WRONG RUNTIME BYTES: promotion is refused unless the archive ships the approved shipped runtime', () => {
    const blocks = jobBlocks(workflow());
    expect(workflow()).not.toContain('data/approved-runtime.json'); // ADR-0091 D3: never a committed pin
    expect(blocks['corpus-identity']).toContain('node scripts/approved-runtime.mjs --resolve --repo "$GITHUB_REPOSITORY"');
    expect(blocks['corpus-publish']).toContain('node scripts/approved-runtime.mjs --verify --archive-manifest');
    const publish = blocks['corpus-publish'];
    // The publisher re-resolves EXACTLY the release identity approved, on its own runner, requires it to
    // name this candidate, and verifies against that pin — it never trusts a pin handed over as output.
    expect(publish).toContain('--resolve --repo "$GITHUB_REPOSITORY" --tag "$APPROVED_TAG"');
    expect(publish).toContain('--pin "$RUNNER_TEMP/approved-runtime.json"');
    expect(publish.indexOf('approved-runtime.mjs --resolve')).toBeLessThan(publish.indexOf('approved-runtime.mjs --verify'));
    // The pin must be checked BEFORE anything is signed: a signature over unapproved executables is
    // the exact artifact this guard exists to never produce.
    expect(publish.indexOf('approved-runtime.mjs --verify')).toBeLessThan(publish.indexOf('sign-bundle.mjs'));
  });

  it('SIGNATURE: the existing signing implementation produces it and the existing verifier proves it', () => {
    const publish = jobBlocks(workflow())['corpus-publish'];
    const sign = publish.indexOf('node scripts/sign-bundle.mjs --bundle');
    const verify = publish.indexOf('node scripts/verify-bundle.mjs');
    const release = publish.indexOf('node scripts/release.mjs --corpus-seed');
    expect(sign).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(sign);
    expect(release).toBeGreaterThan(verify);
    expect(publish).toContain('RUVNET_SIGNING_KEY: ${{ secrets.RUVNET_SIGNING_KEY }}');
  });

  it('CONCURRENCY: only corpus-publish (stage) and corpus-promote join the release group; preparation and the canary do not', () => {
    const source = workflow();
    const blocks = jobBlocks(source);
    // Workflow level: code runs hold `ruvnet-brain-release` for the whole run; corpus runs get their
    // own preparation group, so a nightly preparation never blocks (or waits on) a code release.
    const header = source.slice(0, source.indexOf('\njobs:\n'));
    expect(header).toMatch(/^concurrency:\n {2}group: \$\{\{ inputs\.mode == 'corpus' && 'ruvnet-brain-corpus-preparation' \|\| 'ruvnet-brain-release' \}\}\n {2}cancel-in-progress: false$/m);
    // Job level: the one corpus job that moves releases/latest serializes with code publication.
    expect(blocks['corpus-publish']).toMatch(/\n {4}concurrency:\n {6}group: ruvnet-brain-release\n {6}cancel-in-progress: false\n/);
    expect(blocks['corpus-promote']).toMatch(/\n {4}concurrency:\n {6}group: ruvnet-brain-release\n {6}cancel-in-progress: false\n/);
    for (const job of [...CODE_JOBS, ...CORPUS_JOBS].filter((name) => !['corpus-publish', 'corpus-promote'].includes(name))) {
      expect(blocks[job], `${job} must not declare its own concurrency`).not.toMatch(/\n {4}concurrency:/);
    }
    expect(source).not.toMatch(/cancel-in-progress: true/);
  });

  it('NO-CHANGE ROUND: decided before building (no_change output); publishes nothing and mints no tag', () => {
    const blocks = jobBlocks(workflow());
    expect(blocks['corpus-no-change']).toContain("needs.corpus-prepare.outputs.no_change == 'true'");
    expect(blocks['corpus-authorize']).toContain("needs.corpus-prepare.outputs.no_change != 'true'");
    expect(blocks['corpus-publish']).toContain("needs.corpus-prepare.outputs.no_change != 'true'");
    expect(blocks['corpus-no-change']).not.toContain('release.mjs');
    // The old comparison (rebuilt archive digest vs seed digest) can never match; it is gone.
    expect(workflow()).not.toContain('archive_sha256 == needs.corpus-prepare.outputs.seed_sha256');
    expect(workflow()).not.toContain('archive_sha256 != needs.corpus-prepare.outputs.seed_sha256');
  });

  it('ORDER: authenticate, then import, then publish — bound to the authorized candidate SHA', () => {
    const blocks = jobBlocks(workflow());
    expect(blocks['corpus-prepare']).toContain('uses: ./.github/workflows/corpus-seed.yml');
    expect(blocks['corpus-authorize']).toContain('needs: [corpus-identity, corpus-prepare]');
    expect(blocks['corpus-publish']).toContain('needs: [corpus-identity, corpus-prepare, corpus-authorize]');
    expect(blocks['corpus-publish']).toContain('CORPUS_ARTIFACT_ID: ${{ needs.corpus-authorize.outputs.artifact_id }}');
    // main can move during a multi-hour preparation; the publisher must stay on the SHA that was
    // authorized, or it would ship a runtime nobody checked.
    expect(blocks['corpus-publish']).toContain('ref: ${{ needs.corpus-identity.outputs.candidate_sha }}');
    expect(blocks['corpus-publish']).toContain('test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"');
  });
});

describe('corpus-seed.yml preparation contract', () => {
  it('holds no publication authority of its own', () => {
    const source = seedWorkflow();
    expect(source).toMatch(/^permissions:\n {2}actions: read\n {2}contents: read$/m);
    for (const forbidden of ['gh release create', 'gh release edit', 'npm publish', 'npm dist-tag', 'RUVNET_SIGNING_KEY', 'NPM_TOKEN', 'environment:']) {
      expect(executable(source), `corpus-seed.yml must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('accepts a runtime seed override only as a complete content-addressed identity', () => {
    const source = seedWorkflow();
    expect(source).toContain('a runtime seed override must supply seed_tag, seed_sha256 and seed_bytes together');
    expect(source).toContain("[[ \"$INPUT_SEED_SHA256\" =~ ^[0-9a-f]{64}$ ]]");
    expect(source).toContain("[[ \"$INPUT_SEED_BYTES\" =~ ^[1-9][0-9]*$ ]]");
    expect(source).toContain('seed_tag must never be the mutable latest pointer');
    // No override supplied → the committed bootstrap/recovery pointer, unchanged.
    expect(source).toContain('RESOLVED_SEED_ORIGIN=committed-bootstrap');
    expect(source).toContain('RESOLVED_SEED_ORIGIN=runtime-generation');
    // And the seed digest is still checked against the downloaded bytes.
    expect(source).toContain('sha256sum --check --strict');
  });

  it('uploads one flat artifact root outside the tracked tree, with the identities the consumer checks', () => {
    const source = seedWorkflow();
    expect(source).toContain('path: ${{ runner.temp }}/corpus-prepared/');
    expect(source).not.toMatch(/path: \|\n(\s+\S+\n)*\s+release-evidence\//);
    for (const output of ['artifact_name', 'archive_sha256', 'receipt_sha256', 'seed_sha256']) {
      expect(source, `workflow_call must expose ${output}`).toContain(`${output}:\n        description:`);
    }
    expect(source).toContain('RUVNET_GISTS_TOKEN:');
  });
});

describe('corpus-seed.yml pre-build no-change and decoupling (2026-09-29)', () => {
  it('exposes no_change, wired from the --no-change-out verdict corpus-reconcile always writes', () => {
    const source = seedWorkflow();
    expect(source).toContain('--no-change-out "$RUNNER_TEMP/no-change.json"');
    expect(source).toContain('value: ${{ jobs.prepare.outputs.no_change }}');
    expect(source).toContain('no_change: ${{ steps.nochange.outputs.no_change }}');
    // A missing verdict is a failure, never a quiet night.
    expect(source).toContain("test -s \"$RUNNER_TEMP/no-change.json\" || { echo 'reconciliation wrote no --no-change-out verdict' >&2; exit 1; }");
  });

  it('a no-change night seals, stages and uploads nothing', () => {
    const source = seedWorkflow();
    for (const step of ['Record exact prepared identities', 'Stage the sealed candidate outside the tracked tree',
      'Upload exact candidate for protected-release.yml', 'State the remaining authority boundary']) {
      const body = source.split(`- name: ${step}`)[1].split('\n      - ')[0];
      expect(body, step).toContain("if: steps.nochange.outputs.no_change != 'true'");
    }
    expect(source.indexOf('id: nochange')).toBeLessThan(source.indexOf('id: seal'));
  });

  it('builds at the approved source on main\'s history, never requiring it to BE main HEAD', () => {
    const source = executable(seedWorkflow());
    expect(source).not.toContain('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    expect(source).toContain('git merge-base --is-ancestor "$EXPECTED_SHA" origin/main');
    expect(source).toContain('test "$approved_sha" = "$EXPECTED_SHA"');
  });
});

describe('missing owner prerequisites fail loudly rather than silently', () => {
  it('names the exact owner action when the corpus signing environment has no key', () => {
    // GitHub auto-creates an unknown environment with no secrets, so `Production – corpus` being
    // absent yields an EMPTY key rather than a failed job. An empty key must be named, not inferred.
    const publish = jobBlocks(workflow())['corpus-publish'];
    expect(publish).toContain('if [[ -z "${RUVNET_SIGNING_KEY:-}" ]]; then');
    expect(publish).toContain('OWNER ACTION: create the environment `Production – corpus`');
    // The message must NOT spell the npm token's literal name: the capability gate above is a
    // string match, and a gate that has to allow one spelling in prose can be defeated by that
    // spelling in code. Prose gives way to the gate, never the other way round.
    expect(publish).toMatch(/hold no npm publication credential/);
    const guard = publish.split('if [[ -z "${RUVNET_SIGNING_KEY:-}" ]]; then')[1].split('fi')[0];
    expect(guard).toContain('exit 1');
    // And it fires before signing is attempted.
    expect(publish.indexOf('RUVNET_SIGNING_KEY:-')).toBeLessThan(publish.indexOf('node scripts/sign-bundle.mjs'));
  });

  it('builds at the APPROVED runtime on main\'s history -- ancestry, never main-HEAD equality (2026-09-29)', () => {
    const blocks = jobBlocks(workflow());
    const identity = blocks['corpus-identity'];
    for (const removed of ['test "$GITHUB_SHA" = "$EXPECTED_SHA"', 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
      'test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"']) {
      expect(executable(identity), `corpus-identity must not carry ${removed}`).not.toContain(removed);
    }
    expect(identity).toContain('ref: ${{ github.sha }}');
    expect(identity).toContain('git merge-base --is-ancestor "$EXPECTED_SHA" "$GITHUB_SHA"');
    expect(identity).toContain('git show "$EXPECTED_SHA:package.json"');
    expect(identity).toContain('MIN_PIPELINE_VERSION');
    // The candidate must still be exactly the resolved approved source; a NEWER approved runtime is superseded, not red.
    const guard = identity.split('if [[ "$approved_sha" != "$EXPECTED_SHA" || "$approved_version" != "$EXPECTED_VERSION" ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(guard).toContain('is not the approved runtime');
    expect(guard).toContain('exit 1');
    expect(identity).toContain("echo 'superseded=true' >> \"$GITHUB_OUTPUT\"");
    expect(blocks['corpus-prepare']).toContain("needs.corpus-identity.outputs.superseded != 'true'");
    // ADR-0091 D4: the seed is judged by the approved runtime's own readers, materialized from EXPECTED_SHA.
    expect(identity).toContain('git worktree add --detach "$approved_source" "$EXPECTED_SHA"');
    expect(identity).toContain('--runtime-root "$approved_source" --out "$RUNNER_TEMP/next-seed.json"');
    expect(identity.indexOf('approved-runtime.mjs --resolve')).toBeLessThan(identity.indexOf('corpus-next-seed.mjs'));
    // Provenance: the run is this run (its head is main at dispatch); the artifact is named by the candidate.
    const authorize = blocks['corpus-authorize'];
    expect(authorize).toContain('const runHead = process.env.GITHUB_SHA;');
    expect(authorize).toContain('run.head_sha === runHead');
    expect(authorize).toContain('artifact.workflow_run.head_sha === runHead');
    expect(authorize).toContain('const artifactName = `corpus-seed-prepared-${sha}`');
    // The publisher runs the approved source, proves it is on this run's history, and re-resolves at publish time.
    const publish = blocks['corpus-publish'];
    expect(executable(publish)).not.toContain('test "$CANDIDATE_SHA" = "$GITHUB_SHA"');
    expect(publish).toContain('git merge-base --is-ancestor "$CANDIDATE_SHA" "$GITHUB_SHA"');
    expect(publish.indexOf('merge-base --is-ancestor')).toBeLessThan(publish.indexOf('sign-bundle.mjs'));
    expect(publish).toContain('--approved-tag "$APPROVED_TAG"');
    expect(publish).toContain('APPROVED_TAG: ${{ needs.corpus-identity.outputs.approved_tag }}');
  });

  it('SUPERSEDED (release.mjs exit 4) is a warning with outcome=superseded, never red; anything else non-zero is red', () => {
    const publish = jobBlocks(workflow())['corpus-publish'];
    const step = publish.slice(publish.indexOf('id: publish'));
    const exit4 = step.split('if [[ "$status" -eq 4 ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(exit4).toContain("echo 'outcome=superseded' >> \"$GITHUB_OUTPUT\"");
    expect(exit4).toContain('::warning');
    expect(exit4).toContain('exit 0');
    expect(step.indexOf('if [[ "$status" -eq 4 ]]')).toBeLessThan(step.indexOf('test "$status" -eq 0'));
    expect(step.indexOf('test "$status" -eq 0')).toBeLessThan(step.indexOf("echo 'outcome=staged'"));
    expect(publish).toContain('outcome: ${{ steps.publish.outputs.outcome }}');
  });
});

// Behaviour, not text: the terminal-outcome record the corpus watchdog workflow reads, executed.
describe('corpus terminal outcome, executed', () => {
  const nodeBlock = () => {
    const block = jobBlocks(workflow())['corpus-terminal-outcome'];
    const body = block.split("node - <<'NODE' > corpus-release-outcome.json\n")[1].split('\n          NODE')[0];
    return body.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  };
  const outcome = (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-outcome-'));
    try {
      const result = spawnSync(process.execPath, ['-'], { input: nodeBlock(), encoding: 'utf8', cwd: dir,
        env: { ...process.env, RUN_ID: '1', RUN_ATTEMPT: '1', RUN_URL: 'u', RUN_EVENT: 'workflow_dispatch', RUN_SHA: 'a'.repeat(40), RUN_BRANCH: 'main',
          IDENTITY_RESULT: 'success', PREPARE_RESULT: 'success', NO_CHANGE_RESULT: 'skipped', AUTHORIZE_RESULT: 'success', PUBLISH_RESULT: 'success',
          CANARY_RESULT: 'success', PROMOTE_RESULT: 'success', PROMOTE_OUTCOME: 'published',
          IDENTITY_SUPERSEDED: 'false', PUBLISH_OUTCOME: 'staged', ...env } });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  it.each([
    ['published (staged, canaried, promoted)', {}, 'success', 'published'],
    ['no-change', { NO_CHANGE_RESULT: 'success', AUTHORIZE_RESULT: 'skipped', PUBLISH_RESULT: 'skipped', PUBLISH_OUTCOME: '', CANARY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'success', 'no-change'],
    ['superseded at staging', { PUBLISH_OUTCOME: 'superseded', CANARY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'success', 'superseded'],
    ['superseded at promotion (a code release landed during the canary)', { PROMOTE_OUTCOME: 'superseded' }, 'success', 'superseded'],
    ['superseded at identity', { IDENTITY_SUPERSEDED: 'true', PREPARE_RESULT: 'skipped', AUTHORIZE_RESULT: 'skipped', PUBLISH_RESULT: 'skipped', PUBLISH_OUTCOME: '', CANARY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'success', 'superseded'],
    ['CANARY REFUSED: staged but a clean customer install could not apply it', { CANARY_RESULT: 'failure', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'failure', 'canary-rejected'],
    ['staged and canaried but never promoted is NOT published', { PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'success', 'failed'],
    ['a failed promotion', { PROMOTE_RESULT: 'failure', PROMOTE_OUTCOME: '' }, 'failure', 'failed'],
    ['a failed preparation', { PREPARE_RESULT: 'failure', AUTHORIZE_RESULT: 'skipped', PUBLISH_RESULT: 'skipped', PUBLISH_OUTCOME: '', CANARY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'failure', 'failed'],
    ['a cancelled publish (the watchdog vocabulary has no cancelled: it published nothing)', { PUBLISH_RESULT: 'cancelled', PUBLISH_OUTCOME: '', CANARY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'cancelled', 'failed'],
    ['everything skipped (no outcome reached)', { PREPARE_RESULT: 'skipped', AUTHORIZE_RESULT: 'skipped', PUBLISH_RESULT: 'skipped', PUBLISH_OUTCOME: '', CANARY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped', PROMOTE_OUTCOME: '' }, 'success', 'failed'],
  ])('%s', (_name, env, conclusion, expected) => {
    const record = outcome(env);
    expect(record.conclusion).toBe(conclusion);
    expect(record.outcome).toBe(expected);
    expect(['published', 'no-change', 'superseded', 'canary-rejected', 'failed']).toContain(record.outcome);
    expect(Object.keys(record.jobs)).toEqual(['identity', 'prepare', 'no_change', 'authorize', 'publish', 'canary', 'promote']);
  });

  it('a success conclusion that reached no outcome fails the job loudly', () => {
    const block = jobBlocks(workflow())['corpus-terminal-outcome'];
    const guard = block.split('if [[ "$outcome" = failed && "$conclusion" = success ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(guard).toContain('::error::');
    expect(guard).toContain('exit 1');
  });
});
