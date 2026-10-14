/**
 * ruflo-native-node.test.mjs — hooks that spawn ruflo must run it under a node that can load ITS
 * better-sqlite3, not whichever `node` is first on the hook's PATH.
 *
 * Measured 2026-10-14: ruflo's binding was built for node 24; hooks launched with
 * PATH=/opt/homebrew/bin:… resolved node 26 and `ruflo memory store` was refused with
 * "Native memory writer required" — 67 failed turn captures in one day. Same command, only PATH
 * changed. The fixtures below are real executables on disk (fake `node` shell scripts that exit 0 or 1
 * and record their argv), because the defect is an interpreter-resolution fact, not a function result.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeNodeFor, rufloInvocation } from '../../plugin/scripts/ruflo-bin.mjs';

const POSIX = process.platform !== 'win32';
const roots = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-native-node-'));
  roots.push(root);
  return root;
}

/** A fake ruflo package: <root>/lib/ruflo/bin/ruflo.js, symlinked from <root>/bin/ruflo like npm -g. */
function fakeRuflo({ withAddon = true } = {}) {
  const root = tmp();
  const pkg = path.join(root, 'lib', 'ruflo');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  const entry = path.join(pkg, 'bin', 'ruflo.js');
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  if (withAddon) fs.mkdirSync(path.join(pkg, 'node_modules', 'better-sqlite3'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  const link = path.join(root, 'bin', 'ruflo');
  fs.symlinkSync(entry, link);
  const real = fs.realpathSync(entry); // macOS: /var -> /private/var; the probe uses the real path
  return { root, link, entry: real, addon: path.join(path.dirname(path.dirname(real)), 'node_modules', 'better-sqlite3') };
}

/** A fake `node` in its own dir; `ok` decides whether it "can load the binding"; it logs every call. */
function fakeNode(name, ok) {
  const dir = path.join(tmp(), name);
  fs.mkdirSync(dir);
  const bin = path.join(dir, 'node');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit ${ok ? 0 : 1}\n`, { mode: 0o755 });
  return { bin, dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

describe.skipIf(!POSIX)('nativeNodeFor / rufloInvocation — pick the node that can load the binding', () => {
  const args = ['memory', 'store', '-k', 'k', '--value', 'v'];

  it('leaves a healthy machine EXACTLY as it was when the PATH node can load the binding', () => {
    const r = fakeRuflo();
    const good = fakeNode('good', true);
    expect(nativeNodeFor(r.link, { candidates: [good.bin] })).toBeNull();
    expect(rufloInvocation(r.link, args, { platform: 'darwin', nodeCandidates: [good.bin] }))
      .toEqual({ executable: r.link, args });
  });

  it('runs ruflo under the first node that CAN load it when the PATH node cannot (the 2026-10-14 defect)', () => {
    const r = fakeRuflo();
    const wrong = fakeNode('node26', false);
    const right = fakeNode('node24', true);
    expect(rufloInvocation(r.link, args, { platform: 'darwin', nodeCandidates: [wrong.bin, right.bin] }))
      .toEqual({ executable: right.bin, args: [r.entry, ...args] });
  });

  it('probes with ruflo\'s OWN better-sqlite3, not a version string and not some other copy', () => {
    const r = fakeRuflo();
    const wrong = fakeNode('wrong', false);
    const right = fakeNode('right', true);
    nativeNodeFor(r.link, { candidates: [wrong.bin, right.bin] });
    expect(wrong.calls()).toContain(JSON.stringify(r.addon));
    expect(right.calls()).toContain(JSON.stringify(r.addon));
    expect(right.calls()).toContain(':memory:');
  });

  it('stops at the first node that works — later candidates are never launched', () => {
    const r = fakeRuflo();
    const wrong = fakeNode('wrong', false);
    const right = fakeNode('right', true);
    const spare = fakeNode('spare', true);
    nativeNodeFor(r.link, { candidates: [wrong.bin, right.bin, spare.bin] });
    expect(spare.calls()).toBe('');
  });

  it('changes NOTHING when no candidate can load the binding (never worse than before)', () => {
    const r = fakeRuflo();
    const a = fakeNode('a', false);
    const b = fakeNode('b', false);
    expect(rufloInvocation(r.link, args, { platform: 'darwin', nodeCandidates: [a.bin, b.bin] }))
      .toEqual({ executable: r.link, args });
  });

  it('does not launch anything when ruflo has no better-sqlite3 to be wrong about', () => {
    const r = fakeRuflo({ withAddon: false });
    const probe = fakeNode('probe', false);
    expect(rufloInvocation(r.link, args, { platform: 'darwin', nodeCandidates: [probe.bin] }))
      .toEqual({ executable: r.link, args });
    expect(probe.calls()).toBe('');
  });

  it('honours the CALLER\'s env.PATH order when no explicit candidates are given', () => {
    const r = fakeRuflo();
    const wrong = fakeNode('first', false);
    const right = fakeNode('second', true);
    const env = { PATH: [wrong.dir, right.dir, '/usr/bin', '/bin'].join(path.delimiter) };
    const inv = rufloInvocation(r.link, args, { platform: 'darwin', env });
    expect(inv).toEqual({ executable: right.bin, args: [r.entry, ...args] });
    expect(wrong.calls()).not.toBe('');
  });
});
