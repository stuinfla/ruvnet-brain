// move-brain.test.mjs — 4.5: `npx ruvnet-brain --move-brain <dir>` puts the whole Brain on another disk
// (the owner's is moving to a SanDisk) by copying it, proving the copy byte-identical, and leaving
// ~/.cache/ruvnet-brain as a link to it. If that disk is later unplugged, every surface says so in one
// line and nothing re-creates a fresh brain in ~/.cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultOps, moveBrain, MoveRefused, sweepStaleEndpoints } from '../../scripts/move-brain.mjs';
import { brainLocation, unmountedNotice, volumeOf } from '../../plugin/scripts/brain-location.mjs';
import { runStorageTransaction, treeIdentity } from '../../kb/update-storage-transaction.mjs';
import { acquireRefreshLock, refreshLockPath, releaseRefreshLock } from '../../kb/refresh-run.mjs';
import { sweepStale } from '../../kb/recommend-endpoint.mjs';
import { health } from '../../plugin/scripts/session-start-health.mjs';
import { completeBrain } from '../helpers/doctor-brain-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';
import { journalTurn } from '../../plugin/scripts/turn-transport-journal.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const temps = [];
// Unix socket paths are capped near 104 bytes and macOS's os.tmpdir() alone is ~49, so socket cases use /tmp.
const SHORT_TMP = process.platform === 'win32' ? os.tmpdir() : '/tmp';
const temp = (prefix, base = os.tmpdir()) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, prefix))); temps.push(dir); return dir; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

/** An installed Brain shape: kb with a store and the reader dependency, plus brain-home state. */
function installedBrain(base) {
  const home = temp('move-home-', base);
  const brain = path.join(home, '.cache', 'ruvnet-brain');
  const kb = path.join(brain, 'kb');
  fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
  fs.writeFileSync(path.join(kb, 'store.rvf'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(kb, 'store.passages.jsonl'), '{"id":"1","text":"hello"}\n');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v9.9.1' }));
  fs.symlinkSync('@xenova/transformers/package.json', path.join(kb, 'node_modules', 'semver-link')); // npm-style in-tree link
  fs.writeFileSync(path.join(brain, 'active.json'), '{"version":"9.9.1"}');
  return { home, brain, kb };
}

describe('P097 adopted turn-warning remediation', () => {
  it.each(['unsafe-queue', 'failed-write', 'failed-readback', 'opt-out', 'kb-only-readback'])('actual doctor retains %s evidence and names a safe remedy only when warning', (state) => {
    const b = completeBrain({ modelsReady: true });
    try {
      const bin = path.join(b.parent, 'only-node'); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      const swarm = path.join(b.project, '.swarm'); fs.mkdirSync(swarm); const dbFile = path.join(swarm, 'memory.db');
      const db = new DatabaseSync(dbFile); db.exec('CREATE TABLE memory_entries (key TEXT, namespace TEXT, content TEXT)'); db.close();
      const receiptRoot = state === 'kb-only-readback' ? path.join(b.home, '.cache', 'ruvnet-brain') : b.brainHome;
      const policyDir = path.join(receiptRoot, 'turn-capture'); fs.mkdirSync(policyDir, { recursive: true });
      fs.writeFileSync(path.join(policyDir, 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: { [b.project]: state === 'opt-out' ? 'off' : 'on' } }));
      const queue = path.join(swarm, 'turn-outbox'); const key = 'turn-doctor-remedy'; const stat = fs.statSync(b.project);
      const entry = journalTurn({ kind: 'store', projectRoot: b.project, projectDir: b.project, rootIdentity: `${stat.dev}:${stat.ino}`,
        args: ['memory', 'store', '--key', key, '--value', 'private pending fixture turn', '--namespace', 'turns', '--path', dbFile] }, dbFile, key);
      let preserved = entry;
      if (state === 'unsafe-queue') {
        const retained = path.join(b.parent, 'retained-private-turns'); fs.renameSync(queue, retained); fs.symlinkSync(retained, queue);
        preserved = path.join(retained, path.basename(entry));
      }
      const receipts = path.join(policyDir, 'receipts.jsonl');
      fs.writeFileSync(receipts, JSON.stringify({ kind: 'store', db: dbFile, key, at: new Date().toISOString(),
        status: state === 'failed-write' ? 1 : 0, verified: false, error: state === 'failed-write' ? 'bounded fixture write refused' : 'no exact readback evidence' }) + '\n');
      const queueBefore = fs.readFileSync(preserved); const receiptsBefore = fs.readFileSync(receipts); const dbBefore = fs.readFileSync(dbFile);
      const networkLog = path.join(b.parent, 'blocked-fetch.jsonl'); const preload = path.join(b.parent, 'block-fetch.cjs');
      fs.writeFileSync(preload, `const fs = require('node:fs');globalThis.fetch = async (url, options) => { fs.appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({url:String(url),method:options?.method||'GET',blocked:true})+'\\n'); throw new Error('fixture blocked fetch before network'); };`);
      const extraEnv = { PATH: bin, NODE_OPTIONS: `--require ${preload}`, ...(state === 'kb-only-readback' ? { RUVNET_BRAIN_HOME: '' } : {}) };
      const text = b.doctor([], { extraEnv }); const jsonRun = b.doctor(['--json'], { extraEnv }); const verdict = JSON.parse(jsonRun.stdout);
      const line = verdict.lines.find(row => row.id === 'turn-recording');
      expect([text.status, jsonRun.status, verdict.exitCode]).toEqual([0, 0, 0]);
      if (state === 'opt-out') {
        expect(line.state).toBe('unknown'); expect(line.detail).toMatch(/persisted turn capture opt-out/); expect(line.fix).toBeNull();
        expect(line.detail).not.toMatch(/misconfigured|failing/);
      } else {
        expect(line.state).toBe('warn'); expect(line.detail).toMatch(state === 'unsafe-queue' ? /queue unsafe or unreadable/ : /failing 1\/1/);
        expect(typeof line.fix).toBe('string'); expect(line.fix).toMatch(/preserve|keep/i); expect(line.fix).toMatch(/inspect/i);
        expect(line.fix).not.toMatch(/--clear|rm\s|delete|miswired|misconfigured/i);
        expect(text.text).toContain(line.fix);
        if (state !== 'unsafe-queue') expect(line.fix).toContain(receipts);
        if (state === 'kb-only-readback') expect(line.fix).not.toContain(path.join(path.dirname(b.kbDir), 'turn-capture', 'receipts.jsonl'));
      }
      expect(fs.readFileSync(preserved)).toEqual(queueBefore); expect(fs.readFileSync(receipts)).toEqual(receiptsBefore); expect(fs.readFileSync(dbFile)).toEqual(dbBefore);
      if (state === 'unsafe-queue') expect(fs.lstatSync(queue).isSymbolicLink()).toBe(true);
      const attempts = fs.readFileSync(networkLog, 'utf8').trim().split('\n').map(JSON.parse);
      expect(attempts).toEqual([0, 1].map(() => ({ url: 'https://huggingface.co', method: 'HEAD', blocked: true })));
    } finally { b.cleanup(); }
  }, 60_000);
});

describe('P097 actual doctor consumer matrix with fixture reader', () => {
  it.each(['current', 'stale', 'missing-signature', 'changed-coverage', 'unreadable-signature', 'unreadable-source', ...(process.platform !== 'win32' && process.getuid?.() > 0 ? ['permission-source'] : []), 'moved'])
    ('text, JSON and exit agree for %s state with honest evidence and remedies', (state) => {
      const b = completeBrain({ modelsReady: true });
      try {
        const bin = path.join(b.parent, 'only-node'); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
        const extraEnv = { PATH: bin }; // No Ruflo/host CLI; registry is pinned. Hugging Face HEAD may be attempted.
        if (state === 'stale') {
          const source = JSON.parse(fs.readFileSync(path.join(b.kbDir, 'SOURCE.json')));
          source.builtUtc = new Date(Date.now() - 72 * 3_600_000).toISOString();
          fs.writeFileSync(path.join(b.kbDir, 'SOURCE.json'), JSON.stringify(source));
        } else if (state === 'missing-signature') fs.rmSync(path.join(b.brainHome, 'knowledge-signature.json'));
        else if (state === 'changed-coverage') fs.appendFileSync(path.join(b.kbDir, 'COVERAGE.json'), '\n ');
        else if (state === 'unreadable-signature') fs.writeFileSync(path.join(b.brainHome, 'knowledge-signature.json'), '{');
        else if (state === 'unreadable-source') fs.writeFileSync(path.join(b.kbDir, 'SOURCE.json'), '{');
        else if (state === 'permission-source') {
          const source = path.join(b.kbDir, 'SOURCE.json'); fs.chmodSync(source, 0);
          expect(() => fs.readFileSync(source)).toThrow(expect.objectContaining({ code: 'EACCES' }));
        }
        else if (state === 'moved') {
          const disk = path.join(b.parent, 'mounted-disk', 'brain'); fs.mkdirSync(disk, { recursive: true });
          fs.renameSync(b.kbDir, path.join(disk, 'kb'));
          fs.copyFileSync(path.join(b.brainHome, 'knowledge-signature.json'), path.join(disk, 'knowledge-signature.json'));
          fs.mkdirSync(path.join(b.home, '.cache')); const link = path.join(b.home, '.cache', 'ruvnet-brain'); fs.symlinkSync(disk, link);
          extraEnv.RUVNET_BRAIN_HOME = link; extraEnv.RUVNET_BRAIN_KB = path.join(link, 'kb');
        }
        const text = b.doctor([], { extraEnv }); const jsonRun = b.doctor(['--json'], { extraEnv });
        const verdict = JSON.parse(jsonRun.stdout);
        expect(text.error || jsonRun.error).toBeUndefined();
        expect([text.status, jsonRun.status]).toEqual([verdict.exitCode, verdict.exitCode]);
        expect(verdict.ok).toBe(verdict.exitCode === 0);
        expect(jsonRun.stdout).not.toContain('\u001b');
        for (const line of verdict.lines) {
          expect(text.text).toContain(`${{ok:'✓',fail:'✗',warn:'!',unknown:'○'}[line.state]} ${line.label}`);
          if (line.state === 'fail' || line.state === 'warn') {
            expect(typeof line.fix).toBe('string'); expect(line.fix.length).toBeGreaterThan(0);
            expect(text.text).toContain(line.fix);
          }
        }
        const knowledge = verdict.lines.find(row => row.id === 'knowledge');
        if (['current', 'moved'].includes(state)) { expect(verdict.exitCode).toBe(0); expect(knowledge.state).toBe('ok'); }
        if (['stale', 'missing-signature'].includes(state)) { expect(verdict.exitCode).toBe(0); expect(knowledge.state).toBe('warn'); }
        if (state === 'missing-signature') expect(knowledge.detail).not.toMatch(/signature verified|install record matches/);
        if (['changed-coverage', 'unreadable-signature'].includes(state)) { expect(verdict.exitCode).toBe(1); expect(knowledge.state).toBe('fail'); }
        if (['unreadable-source', 'permission-source'].includes(state)) {
          expect(verdict.exitCode).toBe(1); expect(verdict.lines.find(row => row.id === 'identity').state).toBe('fail');
          expect(knowledge.detail).toMatch(/unknown time/);
        }
        if (state === 'moved') {
          const link = path.join(b.home, '.cache', 'ruvnet-brain'); expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
          expect(fs.readdirSync(path.dirname(link))).toEqual(['ruvnet-brain']);
        }
      } finally { b.cleanup(); }
    }, 60_000);
});

describe('--move-brain', () => {
  it('moves the whole Brain to another disk, leaves a link at the default path, and verifies every byte', () => {
    const { home, brain } = installedBrain();
    const before = treeIdentity(brain).sha256;
    const disk = temp('move-disk-');
    const dest = path.join(disk, 'ruvnet-brain');
    const moved = moveBrain({ home, to: dest });
    expect(moved).toMatchObject({ to: dest, link: brain });
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(brain)).toBe(dest);
    expect(treeIdentity(dest).sha256).toBe(before);
    expect(brainLocation({ home })).toMatchObject({ state: 'linked', real: dest });
    expect(fs.readdirSync(path.dirname(brain)).filter((n) => /\.(old|link|moving)-/.test(n))).toEqual([]);
  });

  it('an update through the link lands on the new disk (the storage transaction follows it)', () => {
    const { home, kb } = installedBrain();
    const dest = path.join(temp('move-disk-'), 'ruvnet-brain');
    moveBrain({ home, to: dest });
    const incoming = temp('move-incoming-');
    fs.cpSync(path.join(dest, 'kb'), incoming, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(path.join(incoming, 'node_modules'), { recursive: true }); // a bundle never ships node_modules
    fs.writeFileSync(path.join(incoming, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v7.7.0' }));
    const result = runStorageTransaction({ liveDir: fs.realpathSync(kb), sourceDir: incoming, transactionId: 'through-link' });
    expect(result.terminalVerdict).toBe('applied');
    expect(JSON.parse(fs.readFileSync(path.join(kb, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v7.7.0'); // read via the link
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'kb', 'SOURCE.json'), 'utf8')).releaseTag).toBe('v7.7.0'); // stored on the disk
    // A reader resolving the default store root reaches the moved store.
    expect(fs.readFileSync(path.join(kb, 'store.passages.jsonl'), 'utf8')).toContain('hello');
  });

  it('moves again to a new disk, and --back brings it home as a real directory', () => {
    const { home, brain } = installedBrain();
    const before = treeIdentity(brain).sha256;
    const first = path.join(temp('move-disk-a-'), 'ruvnet-brain');
    const second = path.join(temp('move-disk-b-'), 'ruvnet-brain');
    moveBrain({ home, to: first });
    moveBrain({ home, to: second });
    expect(fs.realpathSync(brain)).toBe(second);
    expect(fs.existsSync(first)).toBe(false); // the previous off-disk copy is released
    moveBrain({ home, back: true });
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(brain).isDirectory()).toBe(true);
    expect(treeIdentity(brain).sha256).toBe(before);
    expect(fs.existsSync(second)).toBe(false);
  });

  it('refuses, changing nothing: running update, non-empty target, missing disk, no space, already there', () => {
    const { home, brain } = installedBrain();
    const disk = temp('move-disk-');
    const refusal = (options) => { try { moveBrain({ home, ...options }); return null; } catch (e) { expect(e).toBeInstanceOf(MoveRefused); return e.message; } };
    fs.mkdirSync(path.join(brain, '.update.lock'));
    expect(refusal({ to: path.join(disk, 'b') })).toMatch(/an update is running/);
    fs.rmdirSync(path.join(brain, '.update.lock'));
    fs.mkdirSync(path.join(disk, 'full')); fs.writeFileSync(path.join(disk, 'full', 'x'), 'x');
    expect(refusal({ to: path.join(disk, 'full') })).toMatch(/exists and is not empty/);
    expect(refusal({ to: '/Volumes/NoSuchDisk-ruvnet-test/ruvnet-brain' })).toMatch(/does not exist \(is the disk mounted\?\)/);
    expect(refusal({ to: path.join(disk, 'b'), available: () => 10 })).toMatch(/^not enough free disk space to move the Brain/);
    expect(refusal({ to: 'relative/dir' })).toMatch(/needs an absolute directory/);
    expect(refusal({ back: true })).toMatch(/already at its default location/);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false); // every refusal left the Brain where it was
    expect(fs.readdirSync(disk).sort()).toEqual(['full']);
  });
});

const refusalOf = (fn) => { try { fn(); return null; } catch (e) { expect(e).toBeInstanceOf(MoveRefused); return e.message; } };
const leftovers = (brain) => fs.readdirSync(path.dirname(brain)).filter((n) => /\.(old|link|link-old|moving)-/.test(n));

// S1 (review 2026-10-01, reproduced on a real exFAT image: "3 files / 4100 bytes vs 7 files / 20484 bytes"):
// macOS writes an AppleDouble ._<name> beside every copied file with xattrs on exFAT/FAT/NTFS, so a whole-tree
// digest never matched and every move to such a disk refused with "files changed while copying".
describe('--move-brain onto a disk that adds its own metadata (exFAT/FAT/NTFS)', () => {
  /** A copier that behaves like macOS writing to exFAT: the real copy, plus AppleDouble files and volume metadata. */
  const exfatLikeCopy = (extra = () => {}) => (src, dest, filter) => {
    defaultOps.copyTree(src, dest, filter);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && !entry.name.startsWith('._')) fs.writeFileSync(path.join(dir, `._${entry.name}`), Buffer.alloc(4096, 1));
      }
    };
    walk(dest);
    fs.writeFileSync(path.join(dest, '.DS_Store'), 'ds');
    fs.mkdirSync(path.join(dest, '.fseventsd'));
    fs.writeFileSync(path.join(dest, '.fseventsd', 'fseventsd-uuid'), 'u');
    extra(dest);
  };

  it('moves: destination-only AppleDouble ._ files and volume metadata are not differences', () => {
    const { home, brain } = installedBrain();
    const before = treeIdentity(brain).sha256;
    const dest = path.join(temp('move-exfat-'), 'ruvnet-brain');
    const moved = moveBrain({ home, to: dest, ops: { copyTree: exfatLikeCopy() } });
    expect(moved.to).toBe(dest);
    expect(fs.realpathSync(brain)).toBe(dest);
    expect(fs.existsSync(path.join(dest, 'kb', '._store.rvf'))).toBe(true); // the disk's metadata is left alone
    expect(fs.readFileSync(path.join(dest, 'kb', 'store.rvf'))).toEqual(Buffer.alloc(4096, 7));
    expect(leftovers(brain)).toEqual([]);
    expect(before).toBeTruthy();
  });

  it('red: anything else the copy gained, or a file whose bytes differ, refuses — naming it, and nothing moves', () => {
    const { home, brain } = installedBrain();
    const disk = temp('move-exfat-');
    const extraFile = refusalOf(() => moveBrain({ home, to: path.join(disk, 'a'),
      ops: { copyTree: exfatLikeCopy((dest) => fs.writeFileSync(path.join(dest, 'kb', 'stray.json'), '{}')) } }));
    expect(extraFile).toMatch(/^the copy does not match the original: kb[\\/]stray\.json is in the copy but not in the original\. .*The copy was removed and the Brain is unchanged at /);
    // Same size, one byte different: a size/count comparison would pass this; the per-file digest does not.
    const corrupt = refusalOf(() => moveBrain({ home, to: path.join(disk, 'b'),
      ops: { copyTree: exfatLikeCopy((dest) => { const f = path.join(dest, 'kb', 'store.rvf'); const b = fs.readFileSync(f); b[100] ^= 1; fs.writeFileSync(f, b); }) } }));
    expect(corrupt).toMatch(/kb[\\/]store\.rvf differs \(4096 bytes in the original, 4096 in the copy\)/);
    expect(corrupt).not.toMatch(/files changed while copying; retry/); // the old misleading line
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(disk)).toEqual([]);
  });

  // Final Opus re-review of a0074096: --back from exFAT brought the disk's ._ruvector.rvf etc. home, where every
  // reader read them as a fake `._ruvector` store and nothing ever removed them. Volume metadata is the
  // volume's, on EITHER side: never copied, never compared, never required.
  it('--back from an exFAT-like disk leaves its ._ files and volume metadata behind; the home Brain has none', () => {
    const { home, brain } = installedBrain();
    const disk = path.join(temp('move-exfat-'), 'ruvnet-brain');
    moveBrain({ home, to: disk, ops: { copyTree: exfatLikeCopy() } }); // the disk copy now carries ._* twins
    expect(fs.existsSync(path.join(disk, 'kb', '._store.rvf'))).toBe(true);
    fs.writeFileSync(path.join(disk, 'kb', '.DS_Store'), 'finder');
    const moved = moveBrain({ home, back: true });
    expect(moved.to).toBe(brain);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
    const all = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { all.push(e.name); if (e.isDirectory()) walk(path.join(dir, e.name)); } };
    walk(brain);
    expect(all.filter((n) => /^\._|^\.DS_Store$|^\.fseventsd$/.test(n))).toEqual([]);
    expect(fs.readFileSync(path.join(brain, 'kb', 'store.rvf'))).toEqual(Buffer.alloc(4096, 7)); // the real bytes, verified
    expect(fs.existsSync(disk)).toBe(false);
  });

  it('red: metadata exemption is by name only — a REAL file that differs still refuses on the way back', () => {
    const { home } = installedBrain();
    const disk = path.join(temp('move-exfat-'), 'ruvnet-brain');
    moveBrain({ home, to: disk, ops: { copyTree: exfatLikeCopy() } });
    const message = refusalOf(() => moveBrain({ home, back: true, ops: { copyTree: (src, dest, filter) => {
      defaultOps.copyTree(src, dest, filter); fs.writeFileSync(path.join(dest, 'kb', 'SOURCE.json'), '{"tampered":1}');
    } } }));
    expect(message).toMatch(/kb[\\/]SOURCE\.json differs/);
  });

  it.runIf(process.platform === 'darwin')('a real exFAT disk image: the move succeeds, and a disk root is refused as a target', (ctx) => {
    const work = temp('move-dmg-');
    const image = path.join(work, 'disk.dmg');
    const mount = path.join(work, 'mnt');
    const made = spawnSync('hdiutil', ['create', '-size', '64m', '-fs', 'ExFAT', '-volname', 'RVBTEST', image, '-quiet']);
    const attached = made.status === 0 && spawnSync('hdiutil', ['attach', image, '-nobrowse', '-mountpoint', mount, '-quiet']).status === 0;
    if (!attached) { ctx.skip(); return; }
    try {
      const { home, brain } = installedBrain();
      for (const f of ['kb/store.rvf', 'kb/SOURCE.json', 'active.json']) spawnSync('xattr', ['-w', 'com.example.probe', 'x', path.join(brain, f)]);
      const measured = [];
      const available = (dir) => { measured.push(dir); return 1e12; };
      expect(refusalOf(() => moveBrain({ home, to: mount, available }))).toMatch(/is the top of a disk; choose a folder on it, e\.g\. {2}--move-brain .*\/mnt\/ruvnet-brain$/);
      const dest = path.join(mount, 'ruvnet-brain');
      moveBrain({ home, to: dest, available });
      expect(fs.realpathSync(brain)).toBe(fs.realpathSync(dest));
      expect(fs.statSync(measured.at(-1)).dev).toBe(fs.statSync(mount).dev); // space measured on the target disk
      expect(fs.readFileSync(path.join(brain, 'kb', 'store.rvf'))).toEqual(Buffer.alloc(4096, 7));
      expect(fs.readdirSync(path.join(dest, 'kb')).some((n) => n.startsWith('._'))).toBe(true); // the volume did write them
      // ...and --back from the real exFAT disk brings none of them home.
      moveBrain({ home, back: true, available });
      expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
      const names = [];
      const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { names.push(e.name); if (e.isDirectory()) walk(path.join(dir, e.name)); } };
      walk(brain);
      expect(names.filter((n) => n.startsWith('._') || n === '.DS_Store')).toEqual([]);
      expect(fs.readFileSync(path.join(brain, 'kb', 'store.rvf'))).toEqual(Buffer.alloc(4096, 7));
    } finally {
      spawnSync('hdiutil', ['detach', mount, '-force', '-quiet']);
    }
  }, 120_000); // hdiutil create/attach/detach take seconds, more on a loaded machine
});

// S2: a SIGKILLed search worker leaves run/recommend-<pid>.sock behind, and the move died with a raw stack
// ("unsupported filesystem entry in transaction tree: run/recommend-<pid>.sock").
describe.skipIf(process.platform === 'win32')('--move-brain with sockets in the Brain', () => {
  /** Bind a real Unix socket at `file` in a child, then SIGKILL it: the socket file stays, its pid is dead. */
  const staleSocket = (dir) => {
    const child = spawnSync(process.execPath, ['-e', `const p = require('path').join(${JSON.stringify(dir)}, 'recommend-' + process.pid + '.sock');
require('net').createServer().listen(p, () => { console.log(p); process.kill(process.pid, 'SIGKILL'); });`], { encoding: 'utf8' });
    const file = child.stdout.trim();
    expect(fs.lstatSync(file).isSocket()).toBe(true);
    return file;
  };

  it('a stale recommender socket is swept like the endpoint sweeps it, a live one is not copied, and the move succeeds', async () => {
    const { home, brain } = installedBrain(SHORT_TMP);
    const run = path.join(brain, 'run');
    fs.mkdirSync(run, { mode: 0o700 });
    const stale = staleSocket(run);
    fs.writeFileSync(stale.replace(/\.sock$/, '.json'), '{}');
    const net = await import('node:net');
    const live = net.createServer();
    await new Promise((resolve) => live.listen(path.join(run, `recommend-${process.pid}.sock`), resolve));
    try {
      const dest = path.join(temp('mvd-', SHORT_TMP), 'ruvnet-brain');
      moveBrain({ home, to: dest });
      expect(fs.realpathSync(brain)).toBe(dest);
      expect(fs.readdirSync(path.join(dest, 'run'))).toEqual([]); // stale swept; the live socket is not data
      expect(fs.readFileSync(path.join(dest, 'kb', 'store.rvf'))).toEqual(Buffer.alloc(4096, 7));
    } finally { live.close(); }
  });

  it('the stale rule is the endpoint\'s own (kb/recommend-endpoint.mjs sweepStale) on the same directory', () => {
    const make = () => {
      const run = temp('mvs-', SHORT_TMP);
      staleSocket(run);
      fs.writeFileSync(path.join(run, `recommend-${process.pid}.json`), '{}'); // alive: kept
      fs.writeFileSync(path.join(run, `recommend-${2 ** 22 + 7}.json`), '{}'); // dead: swept
      fs.writeFileSync(path.join(run, 'other.sock.txt'), 'x');
      return run;
    };
    const a = make(); const b = make();
    expect(sweepStaleEndpoints(a)).toBe(sweepStale(b));
    expect(fs.readdirSync(a).map((n) => n.replace(/\d+/, 'N')).sort()).toEqual(fs.readdirSync(b).map((n) => n.replace(/\d+/, 'N')).sort());
    expect(fs.readdirSync(a).sort()).toEqual([`recommend-${process.pid}.json`, 'other.sock.txt'].sort());
  });

  it('red: a socket anywhere else is a clean refusal naming the file — never a stack trace — and nothing is copied', () => {
    const { home, brain } = installedBrain(SHORT_TMP);
    const sock = staleSocket(path.join(brain, 'kb'));
    const disk = temp('mvd-', SHORT_TMP);
    const message = refusalOf(() => moveBrain({ home, to: path.join(disk, 'ruvnet-brain') }));
    expect(message).toBe(`${sock} is a socket, which cannot be copied to another disk. Stop whatever created it (or remove it if nothing is using it), then retry. Nothing was moved.`);
    expect(fs.readdirSync(disk)).toEqual([]);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
  });
});

// S3: the steps after the copy (rename the brain home aside, swap the link) were unguarded: a failure left a
// full copy at the target and a stray link, with a raw error.
describe('--move-brain: a failure during the swap puts everything back', () => {
  /** ops whose `renameSync` throws on the call whose (from, to) matches `when`. */
  const failingRename = (when, code = 'EIO', times = 1) => {
    let left = times;
    return { renameSync: (a, b) => {
      if (left > 0 && when(a, b)) { left--; const e = new Error(`injected ${code}`); e.code = code; throw e; }
      return fs.renameSync(a, b);
    } };
  };

  it.each([
    ['setting the brain home aside', (brain) => (a) => a === brain],
    ['putting the link in place', (brain) => (a, b) => b === brain && a.includes('.link-')],
    ['moving the copy into the target', () => (a) => a.includes('.moving-')],
  ])('local → disk, failing at %s: the Brain is unchanged, the copy removed, no stray link', (_step, when) => {
    const { home, brain } = installedBrain();
    const before = treeIdentity(brain).sha256;
    const disk = temp('move-disk-');
    const dest = path.join(disk, 'ruvnet-brain');
    fs.mkdirSync(dest); // an empty target folder the user made: it must be there again afterwards
    const message = refusalOf(() => moveBrain({ home, to: dest, ops: failingRename(when(brain)) }));
    expect(message).toMatch(/^moving the Brain failed while trying to .* \(EIO: injected EIO\)\. Everything was put back: the Brain is unchanged at /);
    expect(fs.lstatSync(brain).isDirectory()).toBe(true);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
    expect(treeIdentity(brain).sha256).toBe(before);
    expect(fs.readdirSync(disk)).toEqual(['ruvnet-brain']);
    expect(fs.readdirSync(dest)).toEqual([]);
    expect(leftovers(brain)).toEqual([]);
    expect(fs.existsSync(refreshLockPath(path.join(brain, 'kb')))).toBe(false); // the lock was released
  });

  it('moving a second time when the link cannot be renamed over (Windows junction semantics) sets it aside and succeeds', () => {
    const { home, brain } = installedBrain();
    const first = path.join(temp('move-disk-a-'), 'ruvnet-brain');
    const second = path.join(temp('move-disk-b-'), 'ruvnet-brain');
    moveBrain({ home, to: first });
    const moved = moveBrain({ home, to: second, ops: failingRename((a, b) => b === brain && a.includes('.link-'), 'EPERM') });
    expect(moved.to).toBe(second);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(brain)).toBe(second);
    expect(fs.existsSync(first)).toBe(false);
    expect(leftovers(brain)).toEqual([]);
  });

  it('moving a second time, failing even after setting the old link aside: the old link is restored', () => {
    const { home, brain } = installedBrain();
    const first = path.join(temp('move-disk-a-'), 'ruvnet-brain');
    const disk = temp('move-disk-b-');
    moveBrain({ home, to: first });
    const message = refusalOf(() => moveBrain({ home, to: path.join(disk, 'ruvnet-brain'),
      ops: failingRename((a, b) => b === brain && a.includes('.link-'), 'EPERM', 2) }));
    expect(message).toMatch(new RegExp(`Everything was put back: the Brain is unchanged at ${first} \\(${brain} links to it\\)\\.$`));
    expect(fs.realpathSync(brain)).toBe(first);
    expect(fs.readdirSync(disk)).toEqual([]);
    expect(leftovers(brain)).toEqual([]);
  });

  it('--back failing at the last rename: the link to the disk copy is restored', () => {
    const { home, brain } = installedBrain();
    const disk = path.join(temp('move-disk-'), 'ruvnet-brain');
    moveBrain({ home, to: disk });
    const message = refusalOf(() => moveBrain({ home, back: true, ops: failingRename((a, b) => b === brain && a.includes('.moving-')) }));
    expect(message).toMatch(/Everything was put back/);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(brain)).toBe(disk);
    expect(leftovers(brain)).toEqual([]);
  });

  it('red: when undoing fails too, the message says where the intact original is and that the path must be repointed', () => {
    const { home, brain } = installedBrain();
    const dest = path.join(temp('move-disk-'), 'ruvnet-brain');
    let setAside = null;
    const ops = { renameSync: (a, b) => {
      if (a === brain) setAside = b;
      if (a.includes('.link-') && b === brain) { const e = new Error('injected'); e.code = 'EIO'; throw e; }
      if (setAside && a === setAside && b === brain) { const e = new Error('restore blocked'); e.code = 'EACCES'; throw e; }
      return fs.renameSync(a, b);
    } };
    const message = refusalOf(() => moveBrain({ home, to: dest, ops }));
    expect(message.startsWith('moving the Brain failed while trying to put the link at ')).toBe(true);
    expect(message).toContain(`and undoing it also failed at: set ${brain} aside (EACCES: restore blocked). The original Brain is intact at ${setAside}; ${brain} must point to it again`);
    expect(fs.readFileSync(path.join(setAside, 'kb', 'store.rvf'))).toEqual(Buffer.alloc(4096, 7)); // really intact where it says
    expect(fs.existsSync(dest)).toBe(false); // the copy was taken back and removed
  });

  it('holds the updater\'s refresh lock for the whole move, and refuses while a live update holds it', () => {
    const { home, brain } = installedBrain();
    const kb = path.join(brain, 'kb');
    let seen = null;
    moveBrain({ home, to: path.join(temp('move-disk-'), 'ruvnet-brain'), ops: { copyTree: (src, dest, filter) => {
      seen = JSON.parse(fs.readFileSync(path.join(refreshLockPath(kb), 'owner.json'), 'utf8'));
      // An update starting now is refused (same exact-identity rule the updater uses).
      expect(() => acquireRefreshLock({ kbDir: kb, brainHome: brain })).toThrow(/another refresh run is active/);
      defaultOps.copyTree(src, dest, filter);
    } } });
    expect(seen).toMatchObject({ pid: process.pid, receiptSeed: { action: 'move-brain' } });
    expect(fs.existsSync(refreshLockPath(kb))).toBe(false);
    const held = acquireRefreshLock({ kbDir: kb, brainHome: brain });
    try {
      expect(refusalOf(() => moveBrain({ home, to: path.join(temp('move-disk-'), 'x') }))).toMatch(/^an update is running or its lock is unclear \(another refresh run is active/);
    } finally { releaseRefreshLock(held); }
  });
});

describe('--move-brain: disk-space edge cases', () => {
  it('Node without fs.statfsSync (< 18.15) degrades to "cannot measure" and still moves, never a TypeError', () => {
    const { home, brain } = installedBrain();
    const lines = [];
    const dest = path.join(temp('move-disk-'), 'ruvnet-brain');
    const moved = moveBrain({ home, to: dest, log: (l) => lines.push(l),
      available: () => { throw new TypeError('fs.statfsSync is not a function'); } });
    expect(fs.realpathSync(brain)).toBe(dest);
    expect(moved.warnings[0]).toMatch(/^could not measure free space on .* \(fs\.statfsSync is not a function\); copying anyway/);
    expect(lines.filter((l) => l.startsWith('could not measure free space'))).toHaveLength(1); // said once
  });

  it('when the old copy cannot be removed after a successful swap, the move stands and says where the unused copy is', () => {
    const { home, brain } = installedBrain();
    const dest = path.join(temp('move-disk-'), 'ruvnet-brain');
    const moved = moveBrain({ home, to: dest, ops: { rmSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } } });
    expect(fs.realpathSync(brain)).toBe(dest);
    expect(moved.warnings).toEqual([expect.stringMatching(/^the previous copy at .*ruvnet-brain\.old-\d+ could not be removed \(EBUSY: busy\); it is no longer used — delete it by hand\.$/)]);
  });

  it('running out of space part-way is a clean refusal, and the partial copy is removed', () => {
    const { home, brain } = installedBrain();
    const disk = temp('move-disk-');
    const message = refusalOf(() => moveBrain({ home, to: path.join(disk, 'ruvnet-brain'), ops: { copyTree: (src, dest) => {
      fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'partial'), 'x');
      const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e;
    } } }));
    expect(message).toMatch(/ran out of space while copying\. The partial copy was removed and the Brain is unchanged at /);
    expect(fs.readdirSync(disk)).toEqual([]);
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(false);
  });

  it('a short disk names the shortfall and suggests a bigger disk — never RUVNET_BRAIN_HOME', () => {
    const { home } = installedBrain();
    const message = refusalOf(() => moveBrain({ home, to: path.join(temp('move-disk-'), 'b'), available: () => 10 }));
    expect(message).toMatch(/^not enough free disk space to move the Brain: .* or choose a folder on a bigger disk\. Nothing was changed\.$/);
    expect(message).not.toMatch(/RUVNET_BRAIN_HOME/);
  });
});

describe('the Brain\'s disk is unplugged (dangling link)', () => {
  const unplug = () => {
    const { home, brain } = installedBrain();
    const disk = temp('move-disk-');
    const dest = path.join(disk, 'ruvnet-brain');
    moveBrain({ home, to: dest });
    fs.renameSync(disk, `${disk}-unplugged`); // the volume disappears
    temps.push(`${disk}-unplugged`);
    return { home, brain, dest };
  };

  it('every surface says one plain line: location, SessionStart health, and the volume name', () => {
    const { home, brain, dest } = unplug();
    const where = brainLocation({ home });
    expect(where).toMatchObject({ state: 'unmounted', target: dest });
    expect(unmountedNotice({ home })).toBe(`RuvNet Brain's disk ${where.volume} is not mounted (${brain} -> ${dest}). Mount it, then retry; nothing was changed. Do NOT reinstall.`);
    expect(health(home, false).problem).toBe(unmountedNotice({ home }));
    // never ADVISES a reinstall: the only mention allowed is the explicit warning not to
    expect(health(home, false).problem.replace("Do NOT reinstall.", "")).not.toMatch(/reinstall/i);
    expect(volumeOf('/Volumes/SanDisk/ruvnet-brain')).toBe('/Volumes/SanDisk');
    expect(volumeOf('/media/stuart/SanDisk/ruvnet-brain')).toBe('/media/stuart/SanDisk');
  });

  it.skipIf(process.platform === 'win32')('unmounted doctor emits one shared failed verdict in text/JSON with a mount-only remedy', () => {
    const { home, brain } = unplug();
    const outputs = [false, true].map(json => spawnSync(process.execPath,
      [path.join(ROOT, 'bin', 'install.mjs'), '--doctor', ...(json ? ['--json'] : [])], { encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: '', RUVNET_BRAIN_KB: '', RUVNET_BRAIN_TEST: '1' } }));
    const verdict = JSON.parse(outputs[1].stdout);
    expect([outputs[0].status, outputs[1].status, verdict.exitCode]).toEqual([1, 1, 1]);
    expect(verdict).toMatchObject({ kind: 'ruvnet-brain-doctor', ok: false, failing: ['knowledge'] });
    const line = verdict.lines.find(row => row.id === 'knowledge');
    expect(line).toMatchObject({ state: 'fail', detail: expect.stringMatching(/disk .* is not mounted/), fix: expect.stringMatching(/^mount /) });
    expect(line.fix).not.toMatch(/install|update|clean/i);
    expect(outputs[0].stdout).toContain(line.detail);
    expect(outputs[0].stdout).toContain(line.fix);
    expect(outputs[1].stdout).not.toContain('\u001b');
    expect(fs.lstatSync(brain).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.dirname(brain))).toEqual(['ruvnet-brain']);
  });

  it.skipIf(process.platform === 'win32')('install and --update refuse in one line and never re-create a brain over the link', () => {
    const { home, brain } = unplug();
    for (const args of [['--yes', '--no-nightly-prompt'], ['--update'], ['--doctor']]) {
      const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), ...args], { encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: '', RUVNET_BRAIN_KB: '', RUVNET_BRAIN_TEST: '1' } });
      const out = `${run.stdout}${run.stderr}`;
      expect(run.status, `${args.join(' ')}\n${out}`).not.toBe(0);
      expect(out, args.join(' ')).toMatch(/RuvNet Brain's disk .* is not mounted/);
      expect(fs.lstatSync(brain).isSymbolicLink(), args.join(' ')).toBe(true); // still the dangling link
      expect(fs.readdirSync(path.dirname(brain)).filter((n) => n !== 'ruvnet-brain')).toEqual([]);
    }
  });
});
