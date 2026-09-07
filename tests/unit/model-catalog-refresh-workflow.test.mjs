import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/model-catalog-refresh.yml'), 'utf8');

// Extract bounded YAML blocks for executable contract tests. Full YAML and reusable-call
// interface validation is also performed with actionlint; this is not a YAML parser.
function block(source, key, indent) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line === `${' '.repeat(indent)}${key}:`);
  if (start < 0) throw new Error(`Missing ${key}`);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].startsWith(' '.repeat(indent + 1)))) end++;
  return lines.slice(start, end).join('\n');
}
function script(stepName) {
  const start = workflow.indexOf(`- name: ${stepName}\n`);
  if (start < 0) throw new Error(`Missing step ${stepName}`);
  const tail = workflow.slice(start);
  const run = tail.match(/\n        run: \|\n((?:          .*\n|\n)+)/);
  if (!run) throw new Error(`Missing executable script ${stepName}`);
  return run[1].split('\n').map(line => line.slice(10)).join('\n');
}
const sha = 'a'.repeat(40);
function execute(step, env) {
  return spawnSync('bash', ['-c', script(step)], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

describe('issue #238 — model catalog refresh has an owner through protected main', () => {
  it('runs weekly with enough recovery time before the 14-day freshness wall', () => {
    expect(workflow).toContain("cron: '13 9 * * 1'");
    expect(block(workflow, 'workflow_dispatch', 2)).toContain('candidate_sha:');
  });

  it('refreshes and verifies facts before creating a maintenance commit', () => {
    expect(workflow.indexOf('npm run catalog:refresh')).toBeLessThan(workflow.indexOf('npm run catalog:verify'));
    expect(workflow.indexOf('npm run catalog:verify')).toBeLessThan(workflow.indexOf('git commit -m'));
  });

  it('uses one PR and the required checks instead of bypassing branch protection', () => {
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('gh workflow run model-catalog-refresh.yml');
    expect(workflow).not.toMatch(/gh workflow run (integration-linux|canonical-qa|ci)\.yml/);
    expect(workflow).toContain("--json autoMergeRequest");
    expect(workflow).toContain('gh pr merge "$pr_number" --auto --squash');
    expect(workflow).not.toMatch(/push origin (main|HEAD:main)/);
  });

  it('calls real reusable interfaces on the immutable candidate, not a main-identity checkout', () => {
    for (const [job, target] of [['verify-ci', 'ci'], ['verify-integration', 'integration-linux'], ['verify-canonical', 'canonical-qa']]) {
      const caller = block(workflow, job, 2);
      expect(caller).toContain('needs: verify-identity');
      expect(caller).toContain(`uses: ./.github/workflows/${target}.yml`);
      expect(caller).toContain('candidate_sha: ${{ inputs.candidate_sha }}');
      const callee = fs.readFileSync(path.join(ROOT, `.github/workflows/${target}.yml`), 'utf8');
      const input = block(block(callee, 'workflow_call', 2), 'candidate_sha', 6);
      expect(input).toContain('required: true');
      expect(input).toContain('type: string');
      for (const checkout of callee.split('- uses: actions/checkout@').slice(1)) {
        expect(checkout.split(/\n      - /)[0]).toContain('ref: ${{ inputs.candidate_sha || github.sha }}');
      }
    }
  });

  it('rejects stale, malformed, wrong-branch and wrong-event verification identities', () => {
    const valid = { CANDIDATE_SHA: sha, EVENT_SHA: sha, EVENT_NAME: 'workflow_dispatch', EVENT_REF: 'refs/heads/automation/model-catalog-refresh', MODE: 'verify' };
    expect(execute('Verify immutable caller identity', valid).status).toBe(0);
    for (const invalid of [{ EVENT_SHA: 'b'.repeat(40) }, { CANDIDATE_SHA: 'main' }, { EVENT_REF: 'refs/heads/main' }, { EVENT_NAME: 'schedule' }, { MODE: 'refresh' }, { CANDIDATE_SHA: '' }]) {
      expect(execute('Verify immutable caller identity', { ...valid, ...invalid }).status).not.toBe(0);
    }
  });

  it('dispatches only the supported self trigger with the captured SHA and protected auto-merge', () => {
    const stub = 'gh() { printf "<%s>" "$@" >&2; printf "\\n" >&2; if [[ "$1 $2" == "pr view" ]]; then echo false; fi; };\n';
    const result = spawnSync('bash', ['-c', stub + script('Request candidate verification and protected merge')], {
      env: { ...process.env, CANDIDATE_SHA: sha, PR_NUMBER: '238', REFRESH_BRANCH: 'automation/model-catalog-refresh' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`<workflow><run><model-catalog-refresh.yml><--ref><automation/model-catalog-refresh><-f><mode=verify><-f><candidate_sha=${sha}>`);
    expect(result.stderr).toContain('<pr><merge><238><--auto><--squash>');
    expect(result.stderr.match(/<workflow><run>/g)).toHaveLength(1);
    expect(workflow).toContain('candidate_sha=$(git rev-parse HEAD)');
    expect(workflow).toContain('CANDIDATE_SHA: ${{ steps.transaction.outputs.candidate_sha }}');
  });

  it('keeps exact required check names and fails every non-success prerequisite', () => {
    // Live main protection requires these two GitHub Actions contexts, not caller/callee prefixes.
    for (const name of ['integration', 'canonical-qa']) {
      const gate = block(workflow, name, 2);
      expect(gate).toContain(`name: ${name}`);
      expect(gate).toContain('always()');
      expect(gate).toContain("inputs.mode == 'verify' || github.ref != 'refs/heads/main'");
      expect(gate).toContain('verify-identity');
      expect(gate).toContain('verify-ci');
      expect(gate).toContain('IDENTITY_RESULT: ${{ needs.verify-identity.result }}');
      expect(gate).toContain('CI_RESULT: ${{ needs.verify-ci.result }}');
      expect(gate).toContain(`QA_RESULT: \${{ needs.${name === 'integration' ? 'verify-integration' : 'verify-canonical'}.result }}`);
      expect(gate).not.toContain('continue-on-error');
      const step = `Require ${name} candidate QA`;
      const valid = { IDENTITY_RESULT: 'success', CI_RESULT: 'success', QA_RESULT: 'success' };
      expect(execute(step, valid).status).toBe(0);
      for (const key of Object.keys(valid)) {
        for (const result of ['failure', 'cancelled', 'skipped', '', 'unknown']) {
          expect(execute(step, { ...valid, [key]: result }).status).not.toBe(0);
        }
      }
    }
  });

  it('never runs the catalog writer from an unverified non-main manual ref', () => {
    expect(block(workflow, 'refresh', 2)).toContain("if: github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || inputs.mode == 'refresh')");
  });
});
