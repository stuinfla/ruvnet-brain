import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPublisherActions } from '../../scripts/release-authority.mjs';
import { MIN_PIPELINE_VERSION, RETRY_CRON } from '../../scripts/corpus-dispatch-decision.mjs';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const DISPATCHER = '.github/workflows/corpus-nightly-dispatch.yml';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const executable = (block) => block.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

describe('corpus nightly dispatcher (ADR-086 step 18)', () => {
  it('turns a schedule into a genuine workflow_dispatch on protected main in corpus mode', () => {
    const source = read(DISPATCHER);
    // Two schedule entries: the night's first slot and its one retry slot (RETRY_CRON), nothing else.
    expect(source).toMatch(/^on:\n {2}schedule:\n {4}# [^\n]*\n {4}- cron: '17 7 \* \* \*'\n {4}# [^\n]*\n {4}- cron: '17 11 \* \* \*'\n {2}workflow_dispatch: \{\}$/m);
    expect(source).toContain(`- cron: '${RETRY_CRON}'`);
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


  it('RETURNS as soon as the protected run exists: no poll, and a 20-minute bound (2026-09-29 redesign)', () => {
    // The 340-minute poll kept a runner alive for hours only to turn a child failure into its own. It
    // is gone: whether a night ended published or no-change is judged by the corpus watchdog workflow, which
    // is on ntfy-alerts' watch list and needs no secret.
    const source = executable(read(DISPATCHER));
    for (const removed of ['gh run view', 'sleep 60', 'deadline=', 'Wait for the dispatched corpus run']) {
      expect(source, `the dispatcher must not carry ${removed}`).not.toContain(removed);
    }
    const jobTimeout = Number((source.match(/timeout-minutes: (\d+)\n\s+permissions:\n\s+contents: read\n\s+actions: write/) || [])[1]);
    expect(jobTimeout).toBe(20);
  });

  it('stays secret-free -- no direct ntfy call', () => {
    const source = executable(read(DISPATCHER));
    expect(source).not.toContain('NTFY_TOPIC');
    expect(source).not.toContain('ntfy.sh');
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

describe('the dispatcher decides through one module, never against main HEAD (2026-09-29 redesign)', () => {
  const armedStep = () => read(DISPATCHER)
    .split("name: Decide whether tonight's corpus run is armed")[1]
    .split('- name:')[0];

  it('never reads a committed pin; it resolves the approved runtime from the signed install verification', () => {
    const source = read(DISPATCHER);
    expect(source).not.toContain('data/approved-runtime.json');
    expect(armedStep()).toContain('node scripts/approved-runtime.mjs --resolve --repo "$GITHUB_REPOSITORY"');
    expect(source).toMatch(/fetch-depth: 0/);
  });

  it('every verdict comes from scripts/corpus-dispatch-decision.mjs; no HEAD or version equality remains', () => {
    const step = executable(armedStep());
    expect(step).toContain('node scripts/corpus-dispatch-decision.mjs --nightly "${CORPUS_NIGHTLY:-}"');
    expect(step).toContain('--github-output "$GITHUB_OUTPUT"');
    for (const removed of ['CANDIDATE_SHA', 'CANDIDATE_VERSION', 'approved_sha" !=', '!= on ]]']) {
      expect(step, `the armed step must not carry ${removed}`).not.toContain(removed);
    }
    // The kill switch is asked of the same module BEFORE the ~555 MB resolve.
    expect(step).toContain('corpus-dispatch-decision.mjs --is-off "${CORPUS_NIGHTLY:-}"');
    expect(step.indexOf('--is-off')).toBeLessThan(step.indexOf('approved-runtime.mjs --resolve'));
    expect(step).toContain('CORPUS_NIGHTLY: ${{ vars.CORPUS_NIGHTLY }}');
  });

  it('dispatches the RESOLVED identity, and every step that can reach the release rail is gated on armed', () => {
    const source = read(DISPATCHER);
    const dispatchStep = source.split('name: Dispatch protected-release.yml on protected main in corpus mode')[1].split('- name:')[0];
    expect(dispatchStep).toContain("if: steps.armed.outputs.armed == 'true'");
    expect(dispatchStep).toContain('CANDIDATE_SHA: ${{ steps.armed.outputs.approved_sha }}');
    expect(dispatchStep).toContain('CANDIDATE_VERSION: ${{ steps.armed.outputs.approved_version }}');
    expect(dispatchStep).toContain('--ref main');
    const gated = source.match(/if: steps\.armed\.outputs\.armed == 'true'/g) || [];
    expect(gated.length).toBe(2);
  });
});

// Behaviour, not text: execute the real decision step's bash, crossing the process boundary.
// `git fetch` is stubbed (no network); the decision module and bash are real.
describe('the decision step, executed', () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
  const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-armed-')); dirs.push(dir); return dir; };
  const [MAJ, MIN, PAT] = MIN_PIPELINE_VERSION.split('.').map(Number);
  const NEWER = `${MAJ}.${MIN}.${PAT + 5}`;
  const BELOW = `${MAJ}.${MIN}.${PAT - 1}`;
  const B = 'b'.repeat(40);

  const script = () => {
    const lines = read(DISPATCHER).split("name: Decide whether tonight's corpus run is armed")[1]
      .split('- name:')[0].split('run: |\n')[1].split('\n');
    const indent = lines[0].match(/^ */)[0].length;
    return lines.map((line) => line.slice(indent)).join('\n');
  };

  /** `resolver`: { status, release } fakes approved-runtime.mjs; or { gh } runs the REAL resolver against a fake gh. */
  function runStep({ resolver, nightly = 'on', eventSchedule = '', gh = null }) {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const resolveLog = path.join(dir, 'resolve-calls');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n[ "$1" = fetch ] && exit 0\nexec ${JSON.stringify(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim())} "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    if (resolver.release !== undefined || resolver.status !== undefined) {
      fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(resolver.release ?? {}));
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
if [ "$1" = scripts/approved-runtime.mjs ]; then echo called >> ${JSON.stringify(resolveLog)}; cat ${JSON.stringify(path.join(dir, 'release.json'))}; exit ${resolver.status ?? 0}; fi
exec ${JSON.stringify(process.execPath)} "$@"\n`);
    } else {
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    }
    fs.chmodSync(path.join(bin, 'node'), 0o755);
    const output = path.join(dir, 'github-output');
    fs.writeFileSync(output, '');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: output, RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain', EVENT_SCHEDULE: eventSchedule,
      ...(resolver.gh || gh ? { RUVNET_GH_COMMAND: resolver.gh || gh } : {}) };
    if (nightly === undefined) delete env.CORPUS_NIGHTLY; else env.CORPUS_NIGHTLY = nightly;
    const result = spawnSync('bash', ['-c', script()], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env });
    return { ...result, output: fs.readFileSync(output, 'utf8'), resolved: fs.existsSync(resolveLog) };
  }

  const fakeGh = (withAggregate, tags = [`v${NEWER}`, `v${BELOW}`]) => {
    const dir = tmp();
    const file = path.join(dir, 'gh.cjs');
    fs.writeFileSync(file, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'list') { process.stdout.write(JSON.stringify(${JSON.stringify(tags.map((tagName) => ({ tagName })))})); process.exit(0); }
if (args[0] === 'api') {
  const assets = [{ name: 'ruvnet-brain.zip' }];
  if (${withAggregate}) assets.push({ name: 'public-verification-aggregate.json' });
  process.stdout.write(JSON.stringify({ assets })); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'download') {
  fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], args[args.indexOf('--pattern') + 1]), '{"verdict":"PASS","forged":true}');
  process.exit(0);
}
process.exit(9);
`);
    const wrapper = path.join(dir, 'gh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(file)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  };

  /** A fake gh for the RETRY SLOT: `run list` answers with tonight's corpus runs; the outcome artifact download
   * fails (as it does for a run that never reached corpus-terminal-outcome) so the job list decides. */
  const fakeRunHistory = (runs) => {
    const dir = tmp();
    const file = path.join(dir, 'gh.cjs');
    const now = Date.now();
    const rows = runs.map((run, index) => ({ databaseId: 9000 + index, attempt: 1, displayTitle: `protected-release corpus corpus-${100 + index}-1`,
      status: run.status || 'completed', conclusion: run.conclusion ?? 'failure', createdAt: new Date(now - (3 - index) * 3_600_000).toISOString(),
      updatedAt: new Date(now - (2 - index) * 3_600_000).toISOString(), jobs: run.jobs || [{ name: 'seal-exact-corpus-candidate', conclusion: 'failure' }] }));
    fs.writeFileSync(file, `const args = process.argv.slice(2); const rows = ${JSON.stringify(rows)};
if (args[0] === 'run' && args[1] === 'list') { process.stdout.write(JSON.stringify(rows)); process.exit(0); }
if (args[0] === 'run' && args[1] === 'download') { process.stderr.write('no artifact matches'); process.exit(1); }
if (args[0] === 'run' && args[1] === 'view') { process.stdout.write(JSON.stringify({ jobs: rows.find((r) => String(r.databaseId) === args[2]).jobs })); process.exit(0); }
process.stderr.write('retry-slot fake gh: ' + args.join(' ')); process.exit(9);
`);
    const wrapper = path.join(dir, 'gh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(file)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  };
  const armedRelease = { release: { tag: `v${NEWER}`, version: NEWER, sourceSha: B } };

  it('RETRY SLOT: one failed run tonight -> arms the retry exactly like the first slot (resolver consulted)', () => {
    const result = runStep({ resolver: armedRelease, eventSchedule: RETRY_CRON, gh: fakeRunHistory([{ conclusion: 'failure' }]) });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.output).toBe(`armed=true\napproved_sha=${B}\napproved_version=${NEWER}\napproved_tag=v${NEWER}\nverdict=arm\n`);
    expect(result.stdout).toMatch(/retry slot retry: corpus run 9000 failed/);
    expect(result.resolved).toBe(true);
  });

  it('RETRY SLOT stands down, resolving nothing, when the night already has an answer, is running, or used its retry', () => {
    const cases = [
      [[{ conclusion: 'success', jobs: [{ name: 'corpus-no-change-round', conclusion: 'success' }] }], /ended no-change/],
      [[{ status: 'in_progress', conclusion: null }], /still in progress/],
      [[{ conclusion: 'failure' }, { conclusion: 'failure' }], /bound is 2 per night/],
      [[], /dispatched no corpus run/],
      [[{ conclusion: 'failure', jobs: [{ name: 'protected-corpus-publisher', conclusion: 'success' }, { name: 'customer-canary', conclusion: 'failure' }] }], /ended canary-rejected/],
      // Every job green yet no outcome: a workflow defect, not weather -- never retried.
      [[{ conclusion: 'success', jobs: [{ name: 'protected-corpus-publisher', conclusion: 'skipped' }] }], /ended unknown/],
    ];
    for (const [runs, reason] of cases) {
      const result = runStep({ resolver: armedRelease, eventSchedule: RETRY_CRON, gh: fakeRunHistory(runs) });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.output, JSON.stringify(runs)).toBe('armed=false\nverdict=retry-stand-down\n');
      expect(result.stdout).toMatch(reason);
      expect(result.resolved, 'the ~555 MB resolve must not run for a stand-down').toBe(false);
    }
  });

  it('RETRY SLOT: the kill switch still wins after a retry verdict', () => {
    const result = runStep({ resolver: armedRelease, nightly: 'off', eventSchedule: RETRY_CRON, gh: fakeRunHistory([{ conclusion: 'failure' }]) });
    expect(result.status).toBe(0);
    expect(result.output).toBe('armed=false\nverdict=stand-down\n');
    expect(result.resolved).toBe(false);
  });

  it('the first slot never consults run history (the schedule is not the retry cron)', () => {
    const result = runStep({ resolver: armedRelease, eventSchedule: '17 7 * * *', gh: fakeRunHistory([{ conclusion: 'failure' }, { conclusion: 'failure' }]) });
    expect(result.output).toContain('armed=true');
  });

  it('MAIN AHEAD of the approved release: still arms, at the approved sourceSha (the old rule stood down)', () => {
    // main HEAD here is this checkout's HEAD; the approved release is a different commit and version.
    const result = runStep({ resolver: { release: { tag: `v${NEWER}`, version: NEWER, sourceSha: B } } });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.output).toBe(`armed=true\napproved_sha=${B}\napproved_version=${NEWER}\napproved_tag=v${NEWER}\nverdict=arm\n`);
  });

  it('kill switch: armed when CORPUS_NIGHTLY is unset; `off` stands down WITHOUT resolving anything', () => {
    const unset = runStep({ nightly: undefined, resolver: { release: { tag: `v${NEWER}`, version: NEWER, sourceSha: B } } });
    expect(unset.status).toBe(0);
    expect(unset.output).toContain('armed=true');
    const off = runStep({ nightly: 'off', resolver: { release: { tag: `v${NEWER}`, version: NEWER, sourceSha: B } } });
    expect(off.status).toBe(0);
    expect(off.output).toBe('armed=false\nverdict=stand-down\n');
    expect(off.resolved).toBe(false);
    expect(off.stdout).toMatch(/::notice::.*kill switch/);
  });

  it('an approved runtime older than the pipeline floor stands down (new workflow text never drives old scripts)', () => {
    const result = runStep({ resolver: { release: { tag: `v${BELOW}`, version: BELOW, sourceSha: B } } });
    expect(result.status).toBe(0);
    expect(result.output).toBe('armed=false\nverdict=stand-down\n');
  });

  it('REAL resolver, newest release has no aggregate yet -> stands down cleanly (exit 0, armed=false)', () => {
    const result = runStep({ resolver: { gh: fakeGh(false) } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('armed=false\nverdict=stand-down\n');
    expect(result.stdout).toMatch(/not reached install-verified yet/);
  });

  it('REAL resolver, VERSION SKEW: newest release below the floor has an aggregate this verifier refuses -> stands down, not red', () => {
    const result = runStep({ resolver: { gh: fakeGh(true, [`v${BELOW}`]) } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.output).toBe('armed=false\nverdict=stand-down\n');
    expect(result.stdout).toMatch(new RegExp(`::notice::.*newest code release v${BELOW.replaceAll('.', '\\.')} predates`));
    // The resolver's own refusal is still shown in the log.
    expect(result.stderr).toMatch(/refusing to fall back/);
  });

  it('REAL resolver, newest release aggregate present but invalid -> fails LOUDLY (exit 1), never an older release', () => {
    const result = runStep({ resolver: { gh: fakeGh(true) } });
    expect(result.status).toBe(1);
    expect(result.output).toBe('armed=false\nverdict=fail\n');
    expect(result.stdout).toMatch(/::error::.*does not hold/);
    expect(result.stderr).toMatch(new RegExp(`v${NEWER.replaceAll('.', '\\.')} \\(the newest\\)[\\s\\S]*refusing to fall back`));
  });
});
