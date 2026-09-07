// tests/unit/md-stamp.test.mjs — the mechanism behind "update every .md's stamp when touched,
// without being reminded" (RuvNet Brain 4.0 LEARNING pillar): a PostToolUse hook, not a memory.
//
// Subprocess-level, same pattern as hook-contract.test.mjs / hook-battery.test.mjs — the hook is
// fed the real Claude Code tool-event JSON on stdin and asserted on its one visible effect (the
// file on disk) and its one contractual promise (exit 0, always). Importing the module and calling
// its functions would prove the string logic works; it would NOT prove the hook survives the actual
// delivery contract (stdin shape, exit code, non-.md/non-Write no-ops) — which is the whole point,
// per this repo's own hook-contract.test.mjs header: "a test that cannot fail on broken code is not
// a test."
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayNY, ensureStamp, hasStamp, stampInsertionPoint } from '../../plugin/scripts/md-stamp.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'plugin/scripts/md-stamp.mjs');
const TODAY = todayNY(); // computed the SAME way the hook computes it — never hardcoded, never flaky

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-stamp-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Fire the hook exactly as hook-shim.mjs / Claude Code do: subprocess, JSON payload on stdin. */
function fireHook(payload, env) {
  const r = spawnSync('node', [HOOK], {
    cwd: tmp,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeFile(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('md-stamp — PostToolUse .md date-stamp refresher', () => {
  it('a stale `Updated:` line gets refreshed to TODAY — the old date is gone', () => {
    const file = writeFile('doc.md', [
      '# Some Doc',
      '',
      'Updated: 2020-01-01 00:00:00 EDT | Version 1.0.0',
      'Created: 2020-01-01 00:00:00 EDT',
      '',
      'Body text unaffected.',
      '',
    ].join('\n'));

    const r = fireHook({ tool_name: 'Write', tool_input: { file_path: file, content: 'irrelevant' } });
    expect(r.code).toBe(0);

    const after = fs.readFileSync(file, 'utf8');
    // KNOWN-BAD if the stamp logic were a no-op: this would still read 2020-01-01 and fail here.
    expect(after).toContain(`Updated: ${TODAY} 00:00:00 EDT`);
    // The OLD date is gone specifically from the Updated: line — Created: also reads 2020-01-01
    // on purpose (a different stamp the hook must never touch), so the check is line-scoped.
    expect(after).not.toMatch(/^Updated: 2020-01-01/m);
    // Everything else on the line — time, TZ, version — survives untouched.
    expect(after).toContain('| Version 1.0.0');
    // Created: is a DIFFERENT stamp and must never be touched by an Updated: refresh.
    expect(after).toContain('Created: 2020-01-01 00:00:00 EDT');
    expect(after).toContain('Body text unaffected.');
  });

  it('a .md already stamped TODAY is left byte-for-byte UNCHANGED — proves idempotency (no loop)', () => {
    const original = [
      '# Some Doc',
      '',
      `Updated: ${TODAY} 00:00:00 EDT | Version 1.0.0`,
      'Created: 2020-01-01 00:00:00 EDT',
      '',
    ].join('\n');
    const file = writeFile('current.md', original);
    const before = fs.statSync(file);

    const r = fireHook({ tool_name: 'Edit', tool_input: { file_path: file } });
    expect(r.code).toBe(0);

    // KNOWN-BAD if the hook always rewrote the file: bytes would still match content-wise but the
    // mtime would have changed — a needless write would also re-trigger this same PostToolUse hook
    // on every future turn, i.e. a loop. So assert BOTH the content and that no write occurred.
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toBe(original);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });

  it('a non-.md file is untouched, exit 0', () => {
    const original = 'Updated: 2020-01-01 00:00:00 EDT | Version 1.0.0\n';
    const file = writeFile('notes.txt', original);

    const r = fireHook({ tool_name: 'Write', tool_input: { file_path: file } });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(original); // KNOWN-BAD: a no-op file check would rewrite this
  });

  it('a non-Write/Edit/MultiEdit tool is untouched, exit 0', () => {
    const original = 'Updated: 2020-01-01 00:00:00 EDT | Version 1.0.0\n';
    const file = writeFile('doc2.md', original);

    const r = fireHook({ tool_name: 'Bash', tool_input: { command: 'echo hi', file_path: file } });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(original); // KNOWN-BAD: a missing tool_name gate would rewrite this
  });

  it('a .md with NO stamp at all is left alone — never invents a format, exit 0', () => {
    const original = '# Just a doc\n\nNo stamp here, ever.\n';
    const file = writeFile('unstamped.md', original);

    const r = fireHook({ tool_name: 'Write', tool_input: { file_path: file } });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('a malformed / unreadable file path does not throw — exit 0, silent', () => {
    const missing = path.join(tmp, 'does-not-exist.md');
    const r = fireHook({ tool_name: 'Write', tool_input: { file_path: missing } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('bad JSON on stdin does not throw — exit 0, silent (fail-open contract)', () => {
    const r = spawnSync('node', [HOOK], { input: 'not json at all {{{', encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stderr ?? '').toBe('');
  });

  it('ADR-style frontmatter `updated:` is refreshed too', () => {
    const original = [
      '---',
      'id: ADR-999',
      'title: Fixture',
      'status: Proposed',
      'date: 2020-01-01',
      'updated: 2020-01-01',
      'authors: [Test]',
      '---',
      '',
      '**Status**: Proposed',
      '',
    ].join('\n');
    const file = writeFile('0999-fixture.md', original);

    const r = fireHook({ tool_name: 'MultiEdit', tool_input: { file_path: file, edits: [{ old_string: 'a', new_string: 'b' }] } });
    expect(r.code).toBe(0);

    const after = fs.readFileSync(file, 'utf8');
    // KNOWN-BAD if frontmatter support were absent: this would still read `updated: 2020-01-01`.
    expect(after).toContain(`updated: ${TODAY}`);
    expect(after).not.toMatch(/^updated: 2020-01-01$/m);
    // `date:` (created) is a DIFFERENT key and must never be touched — ADR-034's rule that `date:`
    // is written once and any diff touching it is a rewrite of the past.
    expect(after).toContain('date: 2020-01-01');
    expect(after).toContain('id: ADR-999');
  });

  it('a frontmatter `updated:` already TODAY is left unchanged (idempotent, same as the plain form)', () => {
    const original = [
      '---',
      'id: ADR-998',
      `updated: ${TODAY}`,
      '---',
      '',
      'body',
      '',
    ].join('\n');
    const file = writeFile('0998-fixture.md', original);
    const before = fs.statSync(file);

    const r = fireHook({ tool_name: 'Edit', tool_input: { file_path: file } });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });
});

describe('md-stamp — the off switch (a file-mutating hook must be silenceable)', () => {
  const staleDoc = ['# Doc', '', 'Updated: 2020-01-01 09:00:00 EST | Version 1.0.0', '', 'body', ''].join('\n');

  it('RUVNET_MD_STAMP=0 makes it a no-op — a STALE stamp is left untouched', () => {
    const file = writeFile('offswitch.md', staleDoc);
    const before = fs.statSync(file);
    const r = fireHook({ tool_name: 'Write', tool_input: { file_path: file } }, { RUVNET_MD_STAMP: '0' });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(staleDoc);                 // still 2020-01-01
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });

  it('CONTROL: the SAME stale doc, no off switch → the date IS refreshed (proves the test has teeth)', () => {
    const file = writeFile('offswitch-control.md', staleDoc);
    const r = fireHook({ tool_name: 'Write', tool_input: { file_path: file } });
    expect(r.code).toBe(0);
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain(`Updated: ${TODAY}`);
    expect(after).not.toContain('2020-01-01');
  });

  it('off is also honoured spelled out (off/false/no)', () => {
    for (const val of ['off', 'false', 'no']) {
      const file = writeFile(`offswitch-${val}.md`, staleDoc);
      fireHook({ tool_name: 'Write', tool_input: { file_path: file } }, { RUVNET_MD_STAMP: val });
      expect(fs.readFileSync(file, 'utf8'), `RUVNET_MD_STAMP=${val}`).toBe(staleDoc);
    }
  });
});

describe('md-stamp — the date is honest across timezones (ships to other machines)', () => {
  it('RUVNET_MD_STAMP_TZ is honoured: an instant that is a different calendar day in two zones', () => {
    // 2026-07-22T11:00Z is already the 23rd in Kiritimati (UTC+14) but still the 22nd in Honolulu (UTC-10).
    const instant = new Date('2026-07-22T11:00:00Z');
    expect(todayNY(instant, 'Pacific/Kiritimati')).toBe('2026-07-23');
    expect(todayNY(instant, 'Pacific/Honolulu')).toBe('2026-07-22');
    expect(todayNY(instant, 'Pacific/Kiritimati')).not.toBe(todayNY(instant, 'Pacific/Honolulu'));
  });

  it('an invalid timezone falls back to system-local instead of throwing', () => {
    expect(() => todayNY(new Date(), 'Not/AZone')).not.toThrow();
    expect(todayNY(new Date(), 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── ENSURE (ADR-056 §2/§3) ───────────────────────────────────────────────────────────────────────
// The hook above only REFRESHES. These cover the second entry point — insertion — which exists
// because the duel proved insert-on-touch "never reaches a stale file, by definition of stale."
// Placement is by SHAPE, and the refusals matter more than the insertions: a wrong insert corrupts
// a document, and five plugin/skills/*/SKILL.md files stop loading if line 1 is not their YAML.
describe('ensureStamp — insertion is by shape, and it refuses what it does not understand', () => {
  it('inserts INSIDE frontmatter, leaving name/description intact (the SKILL.md loader contract)', () => {
    const src = '---\nname: brain-build\ndescription: does a thing\n---\n\n# Title\n\nbody\n';
    const out = ensureStamp(src, { updated: '2026-07-10' });
    expect(out.startsWith('---\nname: brain-build\n')).toBe(true);   // line 1 is STILL the YAML fence
    expect(out).toContain('description: does a thing\nupdated: 2026-07-10\n---');
    expect(out.match(/^---/gm).length).toBe(2);                       // exactly one frontmatter block
  });

  it('REFUSES an unrecognised prologue rather than corrupting it (README opens with <div>)', () => {
    const src = '<div align="center">\n\n![hero](assets/hero.png)\n\n</div>\n';
    expect(stampInsertionPoint(src)).toBeNull();
    expect(ensureStamp(src, { updated: '2026-07-10' })).toBe(src);   // byte-for-byte untouched
  });

  it('REFUSES MDX imports/exports and license banners', () => {
    for (const p of ['import X from "y";\n\n# T\n', 'export const a = 1;\n\n# T\n', '/* (c) 2026 */\n\n# T\n']) {
      expect(ensureStamp(p, { updated: '2026-07-10' })).toBe(p);
    }
  });

  it('places the stamp after a leading H1 — the shape every stamped doc in this repo uses', () => {
    const src = '# DDD-0008 — Currency\n\nbody text\n';
    const out = ensureStamp(src, { updated: '2026-07-22', created: '2026-07-20' });
    expect(out).toBe('# DDD-0008 — Currency\n\nUpdated: 2026-07-22\nCreated: 2026-07-20\n\nbody text\n');
  });

  it('NEVER invents a date — no derived `updated` means no stamp at all', () => {
    const src = '# T\n\nbody\n';
    expect(ensureStamp(src, {})).toBe(src);
    expect(ensureStamp(src, { updated: 'today' })).toBe(src);
    expect(ensureStamp(src, { updated: '2026-7-1' })).toBe(src);      // malformed ⇒ refused
  });

  it('is a no-op on an already-stamped document, in any of the three shapes', () => {
    const plain = '# T\n\nUpdated: 2026-01-01\n\nbody\n';
    const fm = '---\nname: x\nupdated: 2026-01-01\n---\n\nbody\n';
    // The badge shape self-update.mjs maintains in README — missed until 2026-07-27, which made the
    // sweep report README as "prologue not recognised": right outcome, wrong reason.
    const badge = '<div>\n\n### X — [![X version 1.0 — updated 2026-07-27 06:02 EDT](https://img.shields.io/badge/x)](y)\n';
    for (const s of [plain, fm, badge]) {
      expect(hasStamp(s)).toBe(true);
      expect(ensureStamp(s, { updated: '2026-09-09' })).toBe(s);
    }
  });

  it('IS IDEMPOTENT — the whole safety argument, since a hook write re-fires the hook', () => {
    const src = '# T\n\nbody\n';
    const once = ensureStamp(src, { updated: '2026-07-10' });
    expect(ensureStamp(once, { updated: '2026-07-10' })).toBe(once);
    expect(ensureStamp(once, { updated: '2026-08-11' })).toBe(once);  // still stamped ⇒ still no-op
  });
});
