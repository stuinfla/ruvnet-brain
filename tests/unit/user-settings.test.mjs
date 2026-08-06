// user-settings.test.mjs — the user's stated preferences, and the promises made about them.
//
// WHAT THIS PROTECTS. Two things, and they fail in opposite directions.
//
// The first is the DEFAULTS. A settings model is read by exactly one person carefully (the author)
// and by everyone else never — so whatever ships as the default IS the product for almost every user.
// A default that quietly reaches outside their project is therefore not a small mistake; it is the
// behaviour, applied to people who never chose it. The `escalates` field exists to make that
// checkable rather than reviewable, and the numeric class below asserts it on every entry, including
// entries added after this file was written.
//
// The second is DURABILITY. These answers only mean something if they survive — an update, a corrupt
// write, a second session saving at the same moment, and the user's own hand-edit. The high class
// covers the write path for exactly that reason: backup-before-write, merge-don't-clobber, and a
// revert that returns the machine to the state it was actually in rather than to a synthesised one.
//
// The five test classes ADR-028 requires:
//   low         — schema shape and validation, table-driven, no I/O
//   medium      — real filesystem round trip through a temp settings file
//   high        — the write path: backup taken, refuses to clobber, revert is a true undo
//   numeric     — the conservative-defaults invariant, asserted per entry as a count
//   qualitative — each setting explains its own downside in plain English (structure asserted here;
//                 whether the prose is any good is a human's call, per "never grade your own work")

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETTINGS_SCHEMA, SETTINGS_VERSION, STORE_PATH,
  defaults, validate, loadSettings, saveSettings, listBackups, revertSettings, escalatesBeyondProject,
} from '../../scripts/user-settings.mjs';

let tmp, file;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'user-settings-')));
  file = path.join(tmp, 'settings.json');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('low — schema completeness', () => {
  // The four the product promises. Named explicitly so deleting one is a test failure rather than a
  // silently smaller feature.
  it.each(['brainEnabled', 'brainProfile', 'learningScope', 'advocacy', 'autoApply', 'newProjectDefaults'])('defines %s', (key) => {
    expect(SETTINGS_SCHEMA.map((s) => s.key)).toContain(key);
  });

  it('every entry carries all six required fields plus its escalation list', () => {
    for (const s of SETTINGS_SCHEMA) {
      for (const field of ['key', 'label', 'help', 'type', 'whyItMatters', 'downside']) {
        expect(s[field], `${s.key}.${field}`).toBeTruthy();
        expect(typeof s[field], `${s.key}.${field}`).toBe('string');
      }
      expect(s, `${s.key}.default`).toHaveProperty('default');   // may legitimately be `false`
      expect(Array.isArray(s.escalates), `${s.key}.escalates`).toBe(true);
    }
  });

  it('the declared type matches the declared default, and enums list their options', () => {
    for (const s of SETTINGS_SCHEMA) {
      expect(['enum', 'bool'], `${s.key}.type`).toContain(s.type);
      if (s.type === 'bool') {
        expect(typeof s.default, `${s.key}`).toBe('boolean');
      } else {
        expect(Array.isArray(s.options), `${s.key}.options`).toBe(true);
        expect(s.options.length, `${s.key}.options`).toBeGreaterThan(1);
        expect(s.options, `${s.key}.default must be one of its own options`).toContain(s.default);
      }
    }
  });

  it('the two scope enums offer the choices the product describes', () => {
    const scope = SETTINGS_SCHEMA.find((s) => s.key === 'learningScope');
    expect(scope.options).toEqual(['off', 'project', 'user']);
    const advocacy = SETTINGS_SCHEMA.find((s) => s.key === 'advocacy');
    // ADR-052: advocacy became a 1-5 dial (from a 3-value enum). Options are ordered
    // least-active → most-active, same invariant as before, just numeric now.
    expect(advocacy.options).toEqual([1, 2, 3, 4, 5]);
  });

  it('keys are unique — a duplicate would make one entry unreachable through BY_KEY', () => {
    const keys = SETTINGS_SCHEMA.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('low — validation refuses rather than guesses', () => {
  it('accepts a fully-specified valid object unchanged', () => {
    // FULLY specified means every key in SETTINGS_SCHEMA — `brainEnabled` joined it with ADR-054,
    // and advocacy is the 1-5 dial (ADR-052 WIP). Deep equality against the complete values object,
    // so a new key must be added here rather than the assertion loosened.
    const input = { brainEnabled: false, brainProfile: 'ruvector', learningScope: 'user', managedMemoryBoundary: 'read-only', advocacy: 4, autoApply: true, newProjectDefaults: true };
    const r = validate(input);
    expect(r.ok).toBe(true);
    expect(r.values).toEqual(input);
  });

  it('fills every unspecified key from defaults, so callers always get a complete object', () => {
    // The legacy string is deliberately kept here rather than swapped for a bare number: it exercises
    // BOTH halves of validate() in one pass — the ADR-052 legacy migration (off → level 1) AND the
    // defaults-fill for every key the caller did not mention, which is the actual point of this test.
    const r = validate({ advocacy: 'off' });
    expect(r.values).toEqual({ ...defaults(), advocacy: 1 });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['learningScope', 'global'],        // plausible-sounding, not an option
    ['learningScope', true],
    ['brainProfile', 'tiny'],
    ['advocacy', 'IMPORTANT-ONLY'],     // case matters — we do not silently normalise
    ['autoApply', 'true'],              // the string, not the boolean
    ['autoApply', 1],
    ['newProjectDefaults', 'yes'],
  ])('falls back to the default for %s=%o and records WHY', (key, bad) => {
    const r = validate({ [key]: bad });
    expect(r.ok).toBe(false);
    expect(r.values[key]).toBe(defaults()[key]);
    expect(r.errors.some((e) => e.key === key)).toBe(true);
  });

  it('an invalid value costs only its own key — the user keeps the answers they got right', () => {
    // The failure this prevents: one bad field resetting the whole object. A user who set three
    // things correctly and one thing wrong must lose exactly one thing.
    const r = validate({ learningScope: 'user', advocacy: 'nonsense', autoApply: true });
    expect(r.values.learningScope).toBe('user');
    expect(r.values.autoApply).toBe(true);
    expect(r.values.advocacy).toBe(defaults().advocacy);
  });

  it('drops unknown keys with a warning instead of storing them forever', () => {
    const r = validate({ autoApply: false, telepathy: true });
    expect(r.values).not.toHaveProperty('telepathy');
    expect(r.warnings.some((w) => w.key === 'telepathy')).toBe(true);
    expect(r.ok).toBe(true);   // an ignorable extra key is not an error in the user's own answers
  });

  it.each([[null], [[]], ['a string'], [42]])('degrades to defaults on non-object input %o', (bad) => {
    const r = validate(bad);
    expect(r.ok).toBe(false);
    expect(r.values).toEqual(defaults());
  });
});

describe('numeric — the conservative-defaults invariant, asserted per entry', () => {
  // THE test in this file. Stated as a count so it holds for settings that do not exist yet: every
  // entry, present and future, must default to a value that does not act beyond the current project.
  it('zero of the schema entries default to an escalating value', () => {
    const offenders = SETTINGS_SCHEMA.filter((s) => s.escalates.includes(s.default));
    expect(offenders.map((s) => s.key)).toEqual([]);
    expect(offenders.length).toBe(0);
  });

  it('autoApply defaults to false — the one that would let it change the machine unattended', () => {
    expect(defaults().autoApply).toBe(false);
  });

  it('newProjectDefaults defaults to false — writing into projects not yet created is opt-in', () => {
    expect(defaults().newProjectDefaults).toBe(false);
  });

  it('learning does not default to compounding across every project the user owns', () => {
    expect(defaults().learningScope).not.toBe('user');
    expect(escalatesBeyondProject('learningScope', 'user')).toBe(true);
    expect(escalatesBeyondProject('learningScope', 'project')).toBe(false);
  });

  it('at least three of the four settings declare a value that escalates', () => {
    // Guards the opposite failure from the one above: an `escalates: []` on everything would make the
    // invariant vacuously true. If a setting can reach outside the project, it must SAY so.
    const withEscalation = SETTINGS_SCHEMA.filter((s) => s.escalates.length > 0);
    expect(withEscalation.length).toBeGreaterThanOrEqual(3);
  });

  it('advocacy escalates nothing — every level of it is speech, not action', () => {
    expect(SETTINGS_SCHEMA.find((s) => s.key === 'advocacy').escalates).toEqual([]);
  });
});

describe('medium — round trip through a real file', () => {
  it('a fresh machine with no settings file reads as defaults and says so', () => {
    // House rule 3, empty-first: nothing installed must still render honestly.
    const s = loadSettings(file);
    expect(s.exists).toBe(false);
    expect(s.healthy).toBe(true);
    expect(s.values).toEqual(defaults());
    expect(s.errors).toEqual([]);
  });

  it('saves and reads back exactly what was chosen', () => {
    // `brainEnabled: false` is deliberately a NON-default here: this round-trip must prove the
    // MIRROR key survives a real save/load, which is the only thing settings.json is responsible for
    // under ADR-054. (Writing the mirror never touches the sentinel — the switch is flipped only by
    // brain-state.mjs, via the console. See brain-off.test.mjs for that half.)
    const chosen = { brainEnabled: false, brainProfile: 'ruvector', learningScope: 'user', managedMemoryBoundary: 'read-only', advocacy: 4, autoApply: true, newProjectDefaults: true };
    const saved = saveSettings(chosen, { file });
    expect(saved.ok).toBe(true);

    const back = loadSettings(file);
    expect(back.exists).toBe(true);
    expect(back.healthy).toBe(true);
    expect(back.values).toEqual(chosen);
  });

  it('writes a versioned envelope, not a bare settings object', () => {
    saveSettings({ autoApply: true }, { file });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.version).toBe(SETTINGS_VERSION);
    expect(raw.settings.autoApply).toBe(true);
    expect(typeof raw.updated).toBe('string');
  });

  it('a partial save leaves the other answers standing', () => {
    saveSettings({ learningScope: 'user', advocacy: 4 }, { file });
    saveSettings({ autoApply: true }, { file });          // says nothing about the first two
    const back = loadSettings(file);
    expect(back.values.learningScope).toBe('user');
    expect(back.values.advocacy).toBe(4);
    expect(back.values.autoApply).toBe(true);
  });

  it('stores under ~/.config/ruvnet-brain — outside anything --update replaces', () => {
    // Not decoration. bin/install.mjs overwrites ~/.cache/ruvnet-brain wholesale on --update and
    // rmSync's it on --uninstall; it has no code path that touches ~/.config/ruvnet-brain at all.
    // A setting stored in the cache would be destroyed by the next release, which is the same as not
    // having settings.
    expect(STORE_PATH).toContain(path.join('.config', 'ruvnet-brain'));
    expect(STORE_PATH).not.toContain(path.join('.cache', 'ruvnet-brain'));
  });
});

describe('medium — a corrupt or hand-edited file degrades instead of throwing', () => {
  // The user is invited to edit this file by hand (that is why it is readable JSON), and writes get
  // truncated by full disks and killed processes. Every surface that reads settings would otherwise
  // crash on input that is entirely expected.
  it('truncated JSON reads as defaults and reports itself unhealthy', () => {
    fs.writeFileSync(file, '{ "version": 1, "settings": { "autoApply": tr');
    let s;
    expect(() => { s = loadSettings(file); }).not.toThrow();
    expect(s.values).toEqual(defaults());
    expect(s.healthy).toBe(false);
    expect(s.exists).toBe(true);       // it EXISTS and is broken — a different state from absent
    expect(s.errors.length).toBeGreaterThan(0);
  });

  it('an empty file degrades to defaults', () => {
    fs.writeFileSync(file, '');
    const s = loadSettings(file);
    expect(s.values).toEqual(defaults());
    expect(s.healthy).toBe(false);
  });

  it('valid JSON of the wrong shape degrades to defaults', () => {
    fs.writeFileSync(file, JSON.stringify(['not', 'an', 'object']));
    const s = loadSettings(file);
    expect(s.values).toEqual(defaults());
  });

  it('a hand-edited nonsense VALUE keeps the file usable and names the offending key', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { learningScope: 'everywhere', autoApply: false } }));
    const s = loadSettings(file);
    expect(s.values.learningScope).toBe(defaults().learningScope);
    expect(s.healthy).toBe(false);
    expect(s.errors[0].key).toBe('learningScope');
  });

  it('settings from a NEWER version are refused, not reinterpreted', () => {
    // An old reader guessing at a new schema is how a save silently downgrades the user's config.
    fs.writeFileSync(file, JSON.stringify({ version: SETTINGS_VERSION + 5, settings: { autoApply: true } }));
    const s = loadSettings(file);
    expect(s.values.autoApply).toBe(false);
    expect(s.healthy).toBe(false);
    expect(s.errors[0].reason).toMatch(/newer version/);
  });

  it('an unreadable path is a normal empty state, not a crash', () => {
    const s = loadSettings(path.join(tmp, 'no', 'such', 'dir', 'settings.json'));
    expect(s.exists).toBe(false);
    expect(s.values).toEqual(defaults());
  });
});

describe('high — the write path is reversible', () => {
  it('the first save takes no backup and says reverting will remove the file', () => {
    const r = saveSettings({ autoApply: true }, { file });
    expect(r.backup).toBe(null);
    expect(r.existedBefore).toBe(false);
    expect(listBackups(file)).toEqual([]);
  });

  it('every subsequent save backs up the PREVIOUS contents first', () => {
    saveSettings({ advocacy: 1 }, { file });
    const r = saveSettings({ advocacy: 5 }, { file });

    expect(r.backup).toBeTruthy();
    expect(fs.existsSync(r.backup)).toBe(true);
    // The backup must hold the OLD value — a backup taken after the write protects nothing.
    expect(JSON.parse(fs.readFileSync(r.backup, 'utf8')).settings.advocacy).toBe(1);
    expect(loadSettings(file).values.advocacy).toBe(5);
  });

  it('backups accumulate and list newest last', () => {
    saveSettings({ advocacy: 1 }, { file });
    saveSettings({ advocacy: 3 }, { file });
    saveSettings({ advocacy: 5 }, { file });
    const baks = listBackups(file);
    expect(baks.length).toBe(2);
    expect(JSON.parse(fs.readFileSync(baks[baks.length - 1], 'utf8')).settings.advocacy).toBe(3);
  });

  it('rapid consecutive saves each keep their own backup — no undo step is lost', () => {
    // REGRESSION. This started as a flaky assertion in the test above and turned out to be a real
    // defect: backup names are stamped to the millisecond, and saves genuinely land inside the same
    // millisecond, so one copyFileSync silently overwrote another and an undo step vanished with no
    // error. Measured before the fix: six saves, five backups. The loop is deliberately tight —
    // anything slower stops reproducing it.
    const N = 12;
    for (let i = 0; i < N; i++) saveSettings({ advocacy: i % 2 ? 'all' : 'off' }, { file });
    expect(listBackups(file).length).toBe(N - 1);          // every save but the first backs up
    expect(new Set(listBackups(file)).size).toBe(N - 1);   // and every name is distinct
  });

  it('same-millisecond backups still sort newest-last, so an unnamed revert picks the right one', () => {
    // The padding guard: unpadded suffixes would order "-10" before "-2" and revert would restore a
    // backup from the middle of the history rather than the most recent one.
    for (let i = 0; i < 12; i++) saveSettings({ advocacy: 1 }, { file });
    saveSettings({ advocacy: 5 }, { file });            // newest backup holds level 1
    expect(revertSettings({ file }).ok).toBe(true);
    expect(loadSettings(file).values.advocacy).toBe(1);
  });

  it('revert restores the previous answers', () => {
    saveSettings({ learningScope: 'project', autoApply: false }, { file });
    const second = saveSettings({ learningScope: 'user', autoApply: true }, { file });
    expect(loadSettings(file).values.autoApply).toBe(true);

    const r = revertSettings({ file, backup: second.backup });
    expect(r.ok).toBe(true);
    expect(loadSettings(file).values).toEqual({ ...defaults(), learningScope: 'project', autoApply: false });
  });

  it('revert with no named backup restores the most recent one', () => {
    saveSettings({ advocacy: 1 }, { file });
    saveSettings({ advocacy: 5 }, { file });
    expect(revertSettings({ file }).ok).toBe(true);
    expect(loadSettings(file).values.advocacy).toBe(1);
  });

  it('reverting a FIRST save removes the file — back to genuinely having no settings', () => {
    // Restoring "defaults" as a written file would be a different state from never having configured
    // anything, and loadSettings reports those differently (exists: true vs false). Undo must return
    // the machine to where it was, not to something that merely looks equivalent.
    const r = saveSettings({ autoApply: true }, { file });
    const back = revertSettings({ file, backup: r.backup, existedBefore: r.existedBefore });
    expect(back.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(loadSettings(file).exists).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses to write when the backup cannot be taken', () => { // chmod write-blocking is a no-op on win32 (documented gap, ci.yml)
    // A save that cannot be undone is an overwrite. If we cannot secure the old value, the correct
    // answer is to keep it and say so — never to proceed and hope.
    saveSettings({ advocacy: 1 }, { file });
    const roDir = path.join(tmp, 'ro');
    fs.mkdirSync(roDir);
    const roFile = path.join(roDir, 'settings.json');
    fs.copyFileSync(file, roFile);
    fs.chmodSync(roDir, 0o500);            // no new entries may be created in here
    try {
      const r = saveSettings({ advocacy: 5 }, { file: roFile });
      expect(r.ok).toBe(false);
      expect(r.log).toMatch(/backup failed/);
      // The original is untouched.
      expect(loadSettings(roFile).values.advocacy).toBe(1);
    } finally {
      fs.chmodSync(roDir, 0o700);          // always restore, or afterEach cannot clean up
    }
  });

  it('an invalid value in a save falls back to the STORED answer, not the shipped default', () => {
    // A bad click must not reset a setting the user deliberately changed earlier. 4 ≠ the shipped
    // default (3), so this still distinguishes "kept the stored answer" from "fell back to default".
    saveSettings({ advocacy: 4 }, { file });
    const r = saveSettings({ advocacy: 'nonsense' }, { file });
    expect(r.ok).toBe(true);              // written, with the offending key reported
    expect(r.errors.some((e) => e.key === 'advocacy')).toBe(true);
    expect(loadSettings(file).values.advocacy).toBe(4);
  });

  it('a save that follows a corrupt file still produces a readable file', () => {
    fs.writeFileSync(file, 'not json at all');
    const r = saveSettings({ autoApply: true }, { file });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.backup)).toBe(true);           // the corrupt bytes are kept, not discarded
    const back = loadSettings(file);
    expect(back.healthy).toBe(true);
    expect(back.values.autoApply).toBe(true);
  });
});

describe('qualitative — every setting explains its own downside', () => {
  // Structure only. Whether the sentences are actually clear is a human judgement and is not claimed
  // here; what IS enforced is that no setting can ship without someone having written down what
  // turning it up costs. A settings page listing only benefits makes the safe choice look timid.
  it('help is one plain sentence — a short label, not a paragraph', () => {
    // ADR-052: advocacy's help now has to name the 1-5 dial AND both channels it governs (advocacy +
    // lesson-promotion), which is legitimately a little longer than the other three entries' single
    // clause. It gets its own, still-finite ceiling rather than an unbounded pass — a REAL cap, not a
    // vacuous one: it still fails if the copy balloons further, and every other entry is still held
    // to the original 220-char bound.
    for (const s of SETTINGS_SCHEMA) {
      const ceiling = s.key === 'advocacy' ? 260 : 220;
      expect(s.help.length, `${s.key}.help too short`).toBeGreaterThan(30);
      expect(s.help.length, `${s.key}.help is a paragraph, not a sentence`).toBeLessThan(ceiling);
    }
  });

  it('whyItMatters states a real tradeoff, at length', () => {
    for (const s of SETTINGS_SCHEMA) {
      expect(s.whyItMatters.length, `${s.key}.whyItMatters`).toBeGreaterThan(80);
    }
  });

  it('downside names a specific cost and is not a restatement of the benefit', () => {
    for (const s of SETTINGS_SCHEMA) {
      expect(s.downside.length, `${s.key}.downside`).toBeGreaterThan(60);
      expect(s.downside, `${s.key}.downside must differ from whyItMatters`).not.toBe(s.whyItMatters);
    }
  });

  // "The product can never lie" (F: fabricated/undelivered behavior on a user-facing surface). This
  // test used to guard the OPPOSITE claim: the 3-value enum's copy had to admit 'all' and
  // 'important-only' behaved identically, because plugin/scripts/anticipate.sh — at the time the only
  // dial-governed emitter — only ever branched on off-vs-on. ADR-052 replaced the enum with a 1-5
  // dial enforced centrally by plugin/scripts/unprompted-runtime.mjs's LEVEL_POLICY, which DOES
  // differentiate the levels for real (proven by tests/integration/advocacy-dial-levels.test.mjs:
  // promotion is delivered at level 4 but dropped at level 3 — the "TEETH" test there fails outright
  // if that ever collapses back to cosmetic). Leaving the old "these behave identically" admission in
  // the copy would now itself be the lie this house rule exists to catch, so the assertion flips:
  // the copy must NOT claim the levels are unwired/identical, and must name a real, checkable
  // difference between the quiet end (1) and the loud end (4-5).
  it('advocacy copy describes real per-level differences, not a cosmetic dial (ADR-052)', () => {
    const anticipatePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'anticipate.sh',
    );
    const src = fs.readFileSync(anticipatePath, 'utf8');

    // Ground truth for THIS ONE EMITTER (anticipate.sh itself was not touched by ADR-052): it still
    // only branches on off vs. on, with no notion of the 1-5 dial at all. That has not changed, and
    // is a separate fact from whether the LEVELS are load-bearing overall (they are — see above).
    expect(src).toMatch(/ADVOCACY\s*===\s*'off'/);
    expect(src).not.toMatch(/ADVOCACY\s*===\s*'all'/);
    expect(src).not.toMatch(/ADVOCACY\s*===\s*'important-only'/);

    const advocacy = SETTINGS_SCHEMA.find((s) => s.key === 'advocacy');
    const copy = advocacy.downside.toLowerCase();

    // The copy must NOT admit the levels are cosmetic — that admission would now be false.
    expect(copy, 'downside must not claim the levels are identical/unwired — they are now').not.toMatch(/identical|behave the same|not (yet )?wired/);
    // It must name the concrete differentiator the runtime enforces: promotion nudges only exist at
    // the higher levels (4-5), never at 1-3. Merely printing "1" through "5" would not prove this —
    // matching "promot" is what ties the copy to an actual behavioral difference.
    expect(copy, 'downside must describe the promotion-nudge difference at the higher levels').toMatch(/promot/);
    // And it must tie the QUIET end of the dial to real silence, not just mention the number 1.
    expect(copy, 'downside must tie level 1 to genuine silence').toMatch(/\b1\b[^.]{0,60}\b(never|nothing|only when)\b/);
    // ...and tie level 4 specifically to the promotion nudges — the two ends must read as DISTINCT,
    // which is exactly what "identical" used to (honestly) claim they were not, and now must not.
    expect(copy, 'downside must tie level 4 to the promotion nudges').toMatch(/\b4[^.]{0,80}promot/);
  });

  it('no setting is sold — none of the copy tells the user what to pick', () => {
    // The owner's constraint: "doesn't shove suggestions down people's throats". Recommendation
    // language in a settings model turns a choice into a nudge, and a nudge into the default.
    const pushy = /\b(recommended|you should|best option|we suggest|leave this on|turn this on)\b/i;
    for (const s of SETTINGS_SCHEMA) {
      for (const field of ['help', 'whyItMatters', 'downside']) {
        expect(s[field], `${s.key}.${field} reads as a recommendation`).not.toMatch(pushy);
      }
    }
  });

  it('no version literal is embedded in the copy', () => {
    // House rule 4 — a gate greps for X.Y.Z-dev literals. Settings help text outlives releases.
    for (const s of SETTINGS_SCHEMA) {
      for (const field of ['label', 'help', 'whyItMatters', 'downside']) {
        expect(s[field], `${s.key}.${field}`).not.toMatch(/\d+\.\d+\.\d+/);
      }
    }
  });
});
