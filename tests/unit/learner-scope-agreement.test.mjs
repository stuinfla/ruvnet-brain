import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * ISSUE #136 — three files disagreed about WHICH LEARNER they meant.
 *
 * `ruflo hooks intelligence --status` reports `Data Dir: <cwd>/.claude-flow/neural`, so the learner is
 * PROJECT-SCOPED. Measured on one machine in one minute:
 *
 *     ~/.claude-flow/neural          3,167 trajectories · last trained 10.2 DAYS ago   ← what the card read
 *     <project>/.claude-flow/neural 13,607 trajectories · last trained  3.7 days ago   ← the live one
 *
 * So the console reported "Your learner has gone quiet" about a store nothing writes to, while the
 * served project's learner held four times the data. And the REMEDY trained `$HOME` — the store the
 * card does not read — so its own button could never clear the finding it was offered for.
 *
 * This is #104 ("it measures one queue and drains another") and #134 (cwd drift) arriving a third
 * time, in a third file. `onboarding-console.mjs` already carries the verdict on this exact mistake
 * at its refresh-child spawn: *"cwd = the SERVED project, NOT REPO … it was a real console-honesty
 * bug"*. Same rule, same file, different call site.
 *
 * The property is agreement: reader, remedy and label must all mean the served project. Asserted in
 * source because the alternative — spawning `ruflo` three ways — measures one laptop's stores rather
 * than the product's wiring.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The spawn options for the learner call in a file — the block that decides which store is read. */
function learnerSpawnBlock(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  return src.slice(i, i + 600).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

describe('issue #139 — scope is resolved, never hardcoded, and every caller shares one answer', () => {
  it('TEETH: the reporter\'s inversion — user scope moves the learner to HOME', async () => {
    const { learnerCwd, learningScope } = await import('../../plugin/scripts/runtime-preferences.mjs');
    const at = { cwd: path.resolve('/proj'), home: path.resolve('/home') };
    expect(learningScope({ ...at, env: {} }), 'project is the default').toBe('project');
    expect(learnerCwd({ ...at, env: {} }), 'default scope reads the project store').toBe(at.cwd);
    // The case that was broken in both directions and is the whole point of the issue.
    expect(learningScope({ ...at, env: { RUVNET_LEARNING_SCOPE: 'user' } })).toBe('user');
    expect(learnerCwd({ ...at, env: { RUVNET_LEARNING_SCOPE: 'user' } }),
      'user scope must read the HOME store, or the console measures one learner and the flush feeds another')
      .toBe(fs.existsSync(at.home) ? fs.realpathSync.native(at.home) : at.home);
  });

  it('an unrecognised scope falls back to project rather than inventing one', async () => {
    const { learningScope } = await import('../../plugin/scripts/runtime-preferences.mjs');
    for (const bad of ['', 'USER', 'global', 'yes', undefined]) {
      expect(learningScope({ cwd: '/proj', env: { RUVNET_LEARNING_SCOPE: bad } })).toBe('project');
    }
  });

});

// ── #377: the quiet-learner card reads the real distillation time, and the user store is a fixed path ──
const DISTILL_STATUS = `Memory Distillation Status
───────────────────────────────────────────────────────
+--------------------+------+
| Table              | Rows |
+--------------------+------+
| episodes           | 3387 |
| reasoning_patterns | 3386 |
+--------------------+------+

Promote gate (ADR-171)
  promoted: 4   proxy (never promoted): 3382   total patterns: 3386

distill_state cursor
+----------------------+------------+--------------------------+
| Namespace            | Last Rowid | Last Run                 |
+----------------------+------------+--------------------------+
| continuity-events    | 28315      | 2026-10-13T22:30:32.945Z |
| learning-observat... | 28823      | 2026-10-25T22:49:04.444Z |
| turns                | 28824      | 2026-10-25T22:49:04.442Z |
+----------------------+------------+--------------------------+
`; // captured from `ruflo memory distill status --db <copy>` (ruflo 3.63.0); the Namespace column is 20 wide

describe('issue #377 — the learner card is measured from ruflo memory distill status', () => {
  it('parses the truncated namespace cell from the real table output, and stays unknown when ambiguous', async () => {
    const { parseDistillStatus } = await import('../../plugin/scripts/learning-store.mjs');
    expect(parseDistillStatus(DISTILL_STATUS)).toEqual({ known: true, lastDistillAt: '2026-10-25T22:49:04.444Z' });
    expect(parseDistillStatus(DISTILL_STATUS.replace('learning-observat...', 'learning-observations'))).toEqual({ known: true, lastDistillAt: '2026-10-25T22:49:04.444Z' });
    expect(parseDistillStatus(DISTILL_STATUS.replace('| learning-observat... | 28823      | 2026-10-25T22:49:04.444Z |\n', ''))).toEqual({ known: true, lastDistillAt: null });
    expect(parseDistillStatus(DISTILL_STATUS.replace('| turns                |', '| learning-observ...   |'))).toEqual({ known: false, lastDistillAt: null });
    expect(parseDistillStatus('Memory Distillation Status\n\nNo distill_state cursor rows yet (run `memory distill run` first).')).toEqual({ known: true, lastDistillAt: null });
    expect(parseDistillStatus('[ERROR] something else')).toEqual({ known: false, lastDistillAt: null });
  });

  it('a learner distilled after its observations is caught up; observations newer than the distillation are pending', async () => {
    const { learningStoreStatus } = await import('../../plugin/scripts/learning-store.mjs');
    const last = Date.parse('2026-10-25T22:49:04.444Z');
    const rows = (...at) => JSON.stringify(at.map((createdAt, i) => ({ key: `workflow-${i}`, namespace: 'learning-observations', createdAt })));
    const calls = [];
    const run = (listed) => (binary, args) => { calls.push(args.slice(0, 3).join(' ')); return args[1] === 'list' ? { status: 0, stdout: `Transformers.js loaded\n${listed}` } : { status: 0, stdout: DISTILL_STATUS }; };
    expect(learningStoreStatus('/x/.swarm/memory.db', { binary: '/fake/ruflo', run: run(rows(last - 5000, last - 1000)) }))
      .toMatchObject({ known: true, observations: 2, distillKnown: true, lastDistillAt: '2026-10-25T22:49:04.444Z', pendingObservations: 0, oldestPendingAt: null });
    expect(calls).toEqual(['memory list --namespace', 'memory distill status']);
    expect(learningStoreStatus('/x/.swarm/memory.db', { binary: '/fake/ruflo', run: run(rows(last - 1000, last + 1000, last + 9000)) }))
      .toMatchObject({ pendingObservations: 2, oldestPendingAt: new Date(last + 1000).toISOString() });
    const failing = (binary, args) => (args[1] === 'list' ? { status: 0, stdout: rows(last) } : { status: 1, stdout: '' });
    expect(learningStoreStatus('/x/.swarm/memory.db', { binary: '/fake/ruflo', run: failing })).toMatchObject({ known: true, distillKnown: false, pendingObservations: null });
  });

  it('observeLearning sets lastTrainSeconds from the distillation time instead of always null', async () => {
    const { observeLearning } = await import('../../plugin/scripts/learning-store.mjs');
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-377-home-')));
    const project = path.join(home, 'project'); fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
    try {
      const run = (binary, args) => (args[1] === 'list' ? { status: 0, stdout: '[]' } : { status: 0, stdout: DISTILL_STATUS });
      const seen = observeLearning({ env: { HOME: home }, home, cwd: project, binary: '/fake/ruflo', run, now: Date.parse('2026-10-26T22:49:04.444Z') });
      expect(seen).toMatchObject({ enabled: true, statusKnown: true, distillKnown: true, lastTrainSeconds: 86400 });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('the card fires only for observations that have waited over two days, never for a caught-up or unknown learner', async () => {
    const { buildHealthRecommendations } = await import('../../scripts/console-engine.mjs');
    const ids = (learning) => buildHealthRecommendations({ learning }).map((r) => r.id).filter((id) => id === 'learning:train');
    const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();
    const base = { enabled: true, statusKnown: true, distillKnown: true, observations: 40 };
    // The reported defect: observations > 0 with a distillation time that was never read (always null).
    expect(ids({ ...base, lastTrainSeconds: 3600, lastDistillAt: daysAgo(0.04), pendingObservations: 0, oldestPendingAt: null })).toEqual([]);
    expect(ids({ ...base, distillKnown: false, lastTrainSeconds: null, pendingObservations: null })).toEqual([]);
    expect(ids({ ...base, lastTrainSeconds: 3 * 86400, pendingObservations: 3, oldestPendingAt: daysAgo(0.5) })).toEqual([]);
    expect(ids({ ...base, lastTrainSeconds: 5 * 86400, pendingObservations: 3, oldestPendingAt: daysAgo(4) })).toEqual(['learning:train']);
    expect(ids({ ...base, lastTrainSeconds: null, lastDistillAt: null, pendingObservations: 40, oldestPendingAt: daysAgo(3) })).toEqual(['learning:train']);
  });

  it('Apply counts as progress only when the last distillation moved forward', async () => {
    const { learningProgressed, learningProgressDetail } = await import('../../scripts/onboarding-console.mjs');
    const at = (iso) => ({ statusKnown: true, distillKnown: true, lastDistillAt: iso, learningDb: '/p/.swarm/memory.db' });
    expect(learningProgressed(at('2026-10-20T00:00:00Z'), at('2026-10-20T00:00:00Z'))).toBe(false);
    expect(learningProgressed(at(null), at(null))).toBe(false);
    expect(learningProgressed(at('2026-10-20T00:00:00Z'), { ...at('2026-10-21T00:00:00Z'), distillKnown: false })).toBe(false);
    expect(learningProgressed(at('2026-10-20T00:00:00Z'), at('2026-10-21T00:00:00Z'))).toBe(true);
    expect(learningProgressed(at(null), at('2026-10-21T00:00:00Z'))).toBe(true);
    const detail = learningProgressDetail(at('2026-10-20T00:00:00Z'), at('2026-10-20T00:00:00Z'));
    expect(detail).toBe('learner /p/.swarm/memory.db; last distillation 2026-10-20T00:00:00Z → 2026-10-20T00:00:00Z');
    expect(detail).not.toMatch(/queue|undefined/);
  });
});

describe('issue #377 — the user learner store is a fixed path, validated directly', () => {
  const userContext = (home) => ({ enabled: true, scope: 'user', home, projectDir: home });
  const fresh = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-377-user-')));
  const adopt = (home) => { const db = path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'); fs.mkdirSync(path.dirname(db), { recursive: true }); fs.writeFileSync(db, 'SQLite format 3\0'); return db; };

  it('a host that never adopted the user store gets "user store not adopted", not a raw ENOENT', async () => {
    const { learningTarget } = await import('../../plugin/scripts/learning-store.mjs');
    const home = fresh();
    try {
      expect(() => learningTarget(userContext(home), { env: { HOME: home }, explicitLegacyApply: true })).toThrow(/^user store not adopted \(no .*global-memory[\\/]\.swarm[\\/]memory\.db\)$/);
      fs.mkdirSync(path.join(home, '.claude', 'global-memory'), { recursive: true });
      expect(() => learningTarget(userContext(home), { env: { HOME: home }, explicitLegacyApply: true })).toThrow(/^user store not adopted/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('an adopted store is accepted even when ~/.claude is itself a Git checkout', async () => {
    const { learningTarget } = await import('../../plugin/scripts/learning-store.mjs');
    const home = fresh();
    try {
      const db = adopt(home);
      execFileSync('git', ['init', '-q', path.join(home, '.claude')]);
      expect(learningTarget(userContext(home), { env: { HOME: home }, explicitLegacyApply: true })).toBe(db);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses a hard-linked store or a linked learner root', async () => {
    const { learningTarget } = await import('../../plugin/scripts/learning-store.mjs');
    const home = fresh();
    try {
      const db = adopt(home);
      fs.linkSync(db, path.join(home, 'second-name'));
      expect(() => learningTarget(userContext(home), { env: { HOME: home }, explicitLegacyApply: true })).toThrow(/not an exclusive regular file/);
      fs.rmSync(path.join(home, 'second-name'));
      fs.renameSync(path.join(home, '.claude'), path.join(home, 'elsewhere'));
      fs.mkdirSync(path.join(home, '.claude'));
      fs.symlinkSync(path.join(home, 'elsewhere', 'global-memory'), path.join(home, '.claude', 'global-memory'));
      expect(() => learningTarget(userContext(home), { env: { HOME: home }, explicitLegacyApply: true })).toThrow(/not a real directory/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
