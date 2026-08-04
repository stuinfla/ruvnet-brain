/**
 * `health-repair.mjs --flush-learning` — issue #104: the Console remedy "feed your captured work
 * into the learner" could never succeed, and reported "fed 0" forever while the queue grew.
 *
 * It measured one queue and drained another. The flusher was spawned with nothing said about which
 * queue it meant, so learn-flush.mjs fell back to its own defaults — project scope, and session id
 * `default` — and opened `<project>/.swarm/ruvnet-brain-learn/session-default.jsonl`, a file no
 * capture ever writes (learn-capture.sh names files after the REAL session id). Meanwhile this
 * function counted `<user>/.cache/ruvnet-brain/learn/`. `before - after` was structurally 0: it
 * could not report truthfully in either direction even on a flush that worked.
 *
 * Two independent sets of defaults are not an agreement. So the properties held here are:
 *
 *   1. It drains the queue that actually exists — named by session id, not by `default`.
 *   2. It measures the SAME root it drained, whichever scope is configured.
 *   3. It keeps going until the queue is empty (the flusher feeds 8 per call BY DESIGN, so one
 *      call cannot drain a real queue — the reporter needed 15 rounds for 293 entries).
 *   4. When nothing can be fed it says so and exits NON-ZERO, instead of reporting "fed 0" as
 *      success. A remedy that reports success while the problem stands is worse than no remedy.
 *
 * The learner really is invoked: the fake `ruflo` records every call, so these assert that events
 * reached rUv's own tool, not merely that a file disappeared.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'health-repair.mjs');

let root; let home; let project; let marker;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flush-learning-')));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  marker = path.join(root, 'ruflo-calls.txt');
  fs.mkdirSync(project, { recursive: true });
  // The flusher where a real install puts it, so this test is fair to the code it is judging:
  // nothing here depends on which of the two lookup locations is used.
  //
  // WINDOWS: the marketplace path is SIX segments below HOME, and HOME is already inside the
  // runner's temp dir — deep enough to run into MAX_PATH, where cpSync fails and the only symptom
  // is the PRODUCT's own "learn-flush.mjs not found", i.e. the fixture's setup failure reported as
  // a defect in the thing under test. So: prefer the shallow project-local location that
  // flushLearning() also honours, keep the deep one as a best-effort so the real install shape is
  // still exercised where the filesystem allows it, and assert the outcome either way.
  const srcScripts = path.join(ROOT, 'plugin', 'scripts');
  const localDst = path.join(project, 'plugin', 'scripts');
  fs.mkdirSync(path.dirname(localDst), { recursive: true });
  fs.cpSync(srcScripts, localDst, { recursive: true });

  const dst = path.join(home, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin', 'scripts');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(srcScripts, dst, { recursive: true });
  } catch { /* deep-path filesystems only; the project-local copy above is the one that must hold */ }

  // Fail as the fixture, naming itself, rather than letting the product take the blame.
  if (!fs.existsSync(path.join(localDst, 'learn-flush.mjs'))) {
    throw new Error(`fixture setup failed: learn-flush.mjs was not staged at ${localDst}`);
  }
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** rUv's learner, stubbed at the ONE path learn-flush.mjs invokes, recording every call. */
function installRuflo() {
  const bin = path.join(home, '.npm-global', 'bin', 'ruflo');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RUFLO_CALL_MARKER"\nexit 0\n');
  fs.chmodSync(bin, 0o755);
}

function settings(values) {
  const p = path.join(home, '.config', 'ruvnet-brain', 'settings.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ settings: values }, null, 2));
}

/**
 * Queue files as learn-capture.sh actually writes them: `session-<real id>.jsonl`. The literal
 * `session-default.jsonl` is what the old code went looking for and is deliberately never used.
 */
function queue(dir, sessionId, count, tag) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ tool: 'Bash', action: `${tag}-command-${i}` }));
  const file = path.join(dir, `session-${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const depth = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .reduce((n, f) => n + fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length, 0);
  } catch { return 0; }
};
const rufloCalls = () => {
  try { return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};

function flush() {
  const r = spawnSync(process.execPath, [SCRIPT, '--flush-learning'], {
    cwd: project, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      RUVNET_BRAIN_PROJECT_DIR: project,
      RUFLO_CALL_MARKER: marker,
      // The sandbox is HOME **and** PATH. learn-flush resolves ruflo through
      // plugin/scripts/ruflo-bin.mjs, which checks ~/.npm-global/bin/ruflo first and then walks
      // PATH — that PATH walk is the entire point of issues #99/#105. Inheriting the real PATH
      // therefore let the "no ruflo on this machine" case find the DEVELOPER's ruflo and feed for
      // real, so the case silently stopped testing what it names. `installRuflo()` still works
      // because the preferred path is consulted before PATH.
      PATH: path.join(home, '.empty-bin'),
      // Explicitly unset, so nothing here can accidentally hand the child the very agreement the
      // product is supposed to establish for itself.
      RUVNET_LEARNING_SCOPE: undefined,
      LEARN_QUEUE: undefined,
    },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('health-repair --flush-learning (issue #104)', () => {
  it('drains the USER-scope queue it counts, across as many rounds as it takes', () => {
    installRuflo();
    settings({ learningScope: 'user' });
    const dir = path.join(home, '.cache', 'ruvnet-brain', 'learn');
    // 12 > the flusher's per-call limit of 8, so a single invocation CANNOT finish this: the
    // remainder is written back on purpose. One call would leave a queue that "flushes" every time
    // and never empties — the same lie, in slow motion.
    queue(dir, '0f2a9c31-aaaa-4bbb-8ccc-111111111111', 12, 'alpha');
    queue(dir, '7e5b4d22-dddd-4eee-8fff-222222222222', 3, 'beta');

    const { code, out } = flush();

    expect(code, out).toBe(0);
    expect(out, 'the count must be the real delta, not a structural zero').toMatch(/fed 15 captured events/);
    expect(depth(dir), 'the queue it measured is the queue it drained').toBe(0);
    expect(rufloCalls().length, 'the events must reach rUv\'s own learner, not just vanish').toBe(15);
    expect(rufloCalls()[0]).toMatch(/^hooks post-command -c alpha-command-/);
  });

  it('drains the PROJECT-scope queue when that is what is configured, and names that root', () => {
    // The other half of the same bug: whichever scope is in force, the root it counts and the root
    // it drains have to be the same one. Project is the default, so this is the common case.
    installRuflo();
    const dir = path.join(project, '.swarm', 'ruvnet-brain-learn');
    queue(dir, '9c1d7f43-bbbb-4ccc-8ddd-333333333333', 5, 'gamma');

    const { code, out } = flush();

    expect(code, out).toBe(0);
    expect(out).toMatch(/fed 5 captured events into the project learner/);
    expect(out).toMatch(/ruvnet-brain-learn/);
    expect(depth(dir)).toBe(0);
    expect(rufloCalls().length).toBe(5);
  });

  it('exits NON-ZERO and preserves the queue when nothing can actually be fed', () => {
    // No ruflo on this machine, so the flusher feeds nothing and keeps the queue (by design — the
    // queue is evidence). Reporting that as "fed 0" with exit 0 is the product lying about a
    // remedy that did not work.
    settings({ learningScope: 'user' });
    const dir = path.join(home, '.cache', 'ruvnet-brain', 'learn');
    queue(dir, 'aa11bb22-cccc-4ddd-8eee-444444444444', 4, 'delta');

    const { code, out } = flush();

    expect(code, `nothing was fed, so this is not a success\n${out}`).not.toBe(0);
    expect(out).toMatch(/fed 0 of 4 queued events/);
    expect(out).toMatch(/queue is preserved for retry/);
    expect(depth(dir), 'the unfed work must survive for the next attempt').toBe(4);
  });

  it('says learning is switched off rather than reporting a hollow "fed 0"', () => {
    installRuflo();
    settings({ learningScope: 'off' });

    const { code, out } = flush();

    expect(code, out).toBe(0);
    expect(out).toMatch(/switched off/);
    expect(out).not.toMatch(/fed 0/);
  });

  it('reports an empty queue as caught up, naming the root it looked in', () => {
    installRuflo();
    settings({ learningScope: 'user' });

    const { code, out } = flush();

    expect(code, out).toBe(0);
    expect(out).toMatch(/nothing queued in .*ruvnet-brain\/learn/);
  });
});
