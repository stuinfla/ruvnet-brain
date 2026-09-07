import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = name => fs.readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
const ci = read('ci'), canonical = read('canonical-qa'), integration = read('integration-linux'), preflight = read('release-candidate-preflight');
const evaluate = (expression, github, inputs = {}, env = {}) => Function('github', 'inputs', 'env', 'startsWith', `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')})`)(github, inputs, env, (value, prefix) => String(value || '').startsWith(prefix));
const context = (event_name, head_ref = '') => ({ event_name, head_ref, repository: 'stuinfla/ruvnet-brain', event: { pull_request: { head: { repo: { full_name: 'stuinfla/ruvnet-brain' } } } } });
const developmentCondition = canonical.match(/qualify-development:\n    if: (.*)/)[1];
const consumerCondition = integration.match(/QUALIFICATION_CONSUMER: (.*)/)[1];
describe('one qualification producer and receipt-only promotion DAG', () => {
  it('executes three reviewed platform acceptances once for release candidate qualification', () => {
    expect(ci).not.toMatch(/^  (push|pull_request):/m);
    expect(ci).toMatch(/^  workflow_call:/m);
    expect(preflight).toContain("branches: ['release/**']");
    expect(preflight.match(/uses: \.\/\.github\/workflows\/ci.yml/g)).toHaveLength(1);
    const suites = [...ci.matchAll(/run: node scripts\/release-qualification.mjs --platform (linux|macos|windows) /g)].map(match => match[1]);
    expect(suites.sort()).toEqual(['linux', 'macos', 'windows']);
    for (const event of [context('pull_request', 'release/candidate')]) {
      expect(evaluate(developmentCondition, event)).toBe(false);
      expect(evaluate(consumerCondition, event)).toBe(true);
    }
    expect(evaluate(consumerCondition, context('push'), { candidate_sha: 'a'.repeat(40) })).toBe(false);
    expect(ci).not.toMatch(/vitest.*tests\/unit|qa:pr|--lane coverage|--lane mutation|--lane regression/);
    expect(preflight).not.toContain('qualified-candidate-check'); // producer never waits for its consumer
  });
  it('runs reviewed checks on ordinary main pushes without waiting for an absent release artifact', () => {
    for (const event of [context('push'), context('workflow_dispatch')]) {
      expect(evaluate(developmentCondition, event)).toBe(true);
      expect(evaluate(consumerCondition, event)).toBe(false);
    }
    expect(canonical).toContain('release-qualification.mjs --suite source');
    expect(canonical).not.toContain('npm run qa:pr');
    expect(integration).not.toContain('run tests/integration');
    const releaseOnly = canonical.match(/name: Verify already-qualified release source\n        if: (.*)/)[1];
    expect(evaluate(releaseOnly, context('push'))).toBe(false);
    expect(evaluate(releaseOnly, context('pull_request', 'release/candidate'))).toBe(true);
  });
  it('keeps ordinary and fork PRs on deliberate development diagnostics', () => {
    for (const event of [context('pull_request', 'feature/change'), { ...context('pull_request', 'release/fork'), event: { pull_request: { head: { repo: { full_name: 'other/fork' } } } } }]) {
      expect(evaluate(developmentCondition, event)).toBe(true);
      expect(evaluate(consumerCondition, event)).toBe(false);
    }
    expect(read('developer-qa')).toContain('run tests/unit');
    expect(read('developer-qa')).not.toMatch(/^  (push|pull_request|workflow_call):/m);
  });
  it('preserves required contexts without rerunning qualification or bypassing failure', () => {
    for (const [source, check] of [[canonical, 'canonical-qa'], [integration, 'integration']]) {
      expect(source).toContain(`--required-check ${check} --timeout-ms 7200000`);
      expect(source).toContain('github.event.pull_request.head.sha || github.sha');
      expect(source).not.toContain('continue-on-error');
    }
    expect(preflight).toContain('id: qualified-artifact');
    expect(preflight).toContain('qualification-receipt-${{ github.sha }}');
    expect(preflight).toContain('artifact.workflow_run?.id !== runId');
    expect(preflight.indexOf('Persist lightweight qualification receipt')).toBeGreaterThan(preflight.indexOf('Persist the only promotable candidate'));
  });
});
