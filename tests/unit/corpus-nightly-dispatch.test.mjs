import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectPublisherActions } from '../../scripts/release-authority.mjs';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const DISPATCHER = '.github/workflows/corpus-nightly-dispatch.yml';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const executable = (block) => block.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

describe('corpus nightly dispatcher (ADR-086 step 18)', () => {
  it('turns a schedule into a genuine workflow_dispatch on protected main in corpus mode', () => {
    const source = read(DISPATCHER);
    expect(source).toMatch(/^on:\n {2}schedule:\n {4}# [^\n]*\n {4}- cron: '[^']+'\n {2}workflow_dispatch: \{\}$/m);
    expect(source).toContain('gh workflow run protected-release.yml');
    expect(source).toContain('--ref main');
    expect(source).toContain('-f mode=corpus');
    expect(source).toContain('-f "candidate_sha=$CANDIDATE_SHA"');
    expect(source).toContain('-f "version=$CANDIDATE_VERSION"');
  });

  it('PRESERVES the invocation identity predicate rather than weakening it', () => {
    // scripts/protected-release-invocation.mjs is why the dispatcher exists at all. If a future
    // change admits `schedule` there, this dispatcher becomes pointless AND the boundary is gone.
    const invocation = read('scripts/protected-release-invocation.mjs');
    expect(invocation).toContain("env.GITHUB_EVENT_NAME !== 'workflow_dispatch'");
    expect(invocation).toContain("env.GITHUB_WORKFLOW !== PROTECTED_WORKFLOW");
    expect(invocation).toContain("env.GITHUB_REF_PROTECTED !== 'true'");
    expect(invocation).not.toContain("'schedule'");
    // And protected-release.yml itself still carries no schedule trigger.
    expect(read('.github/workflows/protected-release.yml')).not.toMatch(/^\s{2}schedule:/m);
  });

  it('NO SIGNING OR PUBLICATION AUTHORITY: contents:read and actions:write, nothing more', () => {
    const source = executable(read(DISPATCHER));
    expect(source).toMatch(/^permissions:\n {2}contents: read\n {2}actions: write$/m);
    expect(source.match(/permissions:\n {6}contents: read\n {6}actions: write/g)).toHaveLength(1);
    for (const forbidden of [
      'contents: write', 'id-token', 'environment:', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
      'RUVNET_SIGNING_KEY', 'sign-bundle.mjs', 'release.mjs', 'gh release', 'npm publish', 'npm dist-tag',
    ]) {
      expect(source, `the dispatcher must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // The only secret-shaped expression permitted is the built-in Actions token.
    const secretRefs = [...source.matchAll(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/g)].map(([match]) => match);
    expect(secretRefs).toEqual([]);
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('is invisible to the one-publisher source gate', () => {
    // The same predicate CI runs. A dispatcher that tripped it would be a second publisher.
    expect(detectPublisherActions(DISPATCHER, read(DISPATCHER))).toEqual([]);
  });

  it('never dispatches from a fork that merely inherited the schedule', () => {
    expect(read(DISPATCHER)).toContain("if: github.repository == 'stuinfla/ruvnet-brain'");
  });

  it('FAILS the night when gh workflow run produces no target run — the A5 run record is mandatory', () => {
    const source = read(DISPATCHER);
    expect(source).toContain('event=workflow_dispatch');
    expect(source).toContain('test "$run_event" = workflow_dispatch');
    expect(source).toContain('no protected-release run with event=workflow_dispatch appeared');
    // A missing record must exit non-zero, not warn: "reported success but nothing ran" is exactly
    // the silent-failure shape this project has been bitten by before.
    const guard = source.split('if [[ -z "$record" ]]; then')[1]?.split('fi')[0] || '';
    expect(guard).toContain('exit 1');
    expect(source).toContain('dispatched-run.json');
  });


  it('does not hold a second runner open while the protected child completes', () => {
    const source = executable(read(DISPATCHER));
    expect(source).not.toContain('while (( SECONDS - started');
    expect(source).not.toContain('target-run-status.json');
    expect(source).not.toContain('sleep 30');
    expect(source).toContain("recorded by the protected child's always-running corpus-terminal-outcome job");
  });

  it('preserves success/failure/cancellation/timeout visibility without polling', () => {
    const source = read(DISPATCHER);
    const notifier = read('.github/workflows/ntfy-alerts.yml');
    const protectedRelease = read('.github/workflows/protected-release.yml');
    expect(source).toContain('target run: [$run_id]($run_url)');
    expect(notifier).toContain('"protected-release"');
    expect(protectedRelease).toContain('corpus-terminal-outcome:');
    expect(protectedRelease).toContain("if: always() && inputs.mode == 'corpus'");
    expect(protectedRelease).toContain('name: corpus-release-outcome-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(protectedRelease).toContain('retention-days: 90');
    expect(() => read('.github/workflows/corpus-release-outcome.yml')).toThrow();
    expect(notifier).toContain('types: [completed]');
    expect(notifier).toContain('[ "$WR_CONC" = "success" ] && exit 0');
    expect(notifier).toContain('TITLE="🔴 CI ${WR_CONC}: ${WR_NAME}"');
  });

  it('records the dispatch against the exact candidate it dispatched', () => {
    const source = read(DISPATCHER);
    expect(source).toContain('node scripts/corpus-dispatch-receipt.mjs');
    expect(source).toContain('corpus_dispatch_id=$CORPUS_DISPATCH_ID');
    const selector = read('scripts/corpus-dispatch-receipt.mjs');
    expect(selector).toContain('run.head_sha === sha');
    expect(selector).toContain('Date.parse(run.created_at) >= Date.parse(notBefore)');
  });
});

describe('the dispatcher is disarmed until step 16 has shipped (ADR-086 A7 ordering)', () => {
  it('stands down cleanly rather than dispatching before an owner-gated code release pins the runtime', () => {
    const source = read(DISPATCHER);
    expect(source).toContain('if [[ -s data/approved-runtime.json ]]; then');
    expect(source).toContain("echo 'armed=true' >> \"$GITHUB_OUTPUT\"");
    expect(source).toContain("echo 'armed=false' >> \"$GITHUB_OUTPUT\"");
    expect(source).toContain('corpus-nightly-dispatch is DISARMED');
    // Every step that can reach the release rail is gated on the armed state.
    const gated = source.match(/if: steps\.armed\.outputs\.armed == 'true'/g) || [];
    expect(gated.length).toBeGreaterThanOrEqual(2);
    const dispatchStep = source.split('name: Dispatch protected-release.yml on protected main in corpus mode')[1].split('- name:')[0];
    expect(dispatchStep).toContain("if: steps.armed.outputs.armed == 'true'");
    // Disarmed is NOT a failure: a nightly red X for a correctly-disarmed scheduler trains the owner
    // to ignore the alert that matters.
    const armedStep = source.split('name: Stand down until an owner-gated code release has armed unattended promotion')[1].split('- id:')[0].split('- name:')[0];
    expect(armedStep).not.toContain('exit 1');
    expect(armedStep).not.toContain('::error::');
  });
});
