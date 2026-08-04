/**
 * `forge-update.mjs --apply`, end to end, against a real local release: the exit code AND the
 * rollback copy, in the same run — because in issues #106 and #108 they were the same run.
 *
 *   #106  the run knew it had failed, said so in the log, and still exited 0 through the caller.
 *   #108  the run had actually SUCCEEDED, aborted on a store that was legitimately unchanged, and
 *         the abort jumped straight over the release step — ~1.6 GB stranded per night, ten copies
 *         (~16 GB) before the owner noticed. Their workaround was to run the updater, IGNORE its
 *         exit code, and call reclaimBackups() by hand.
 *
 * So every case here asserts both halves: what the process exits with, and what it leaves on disk.
 * A truthful exit code that strands 1.6 GB is only half a fix, and so is a clean disk that lies.
 *
 * Nothing is mocked below the network boundary — a real zip, a real extraction, a real directory
 * swap, real rollback copies — because the property under test is what ends up on the filesystem.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasZip = () => { try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
const CAN_ZIP = hasZip();

const STORE_A = { kbName: 'alpha', sourceCommit: 'aaa111aaa111', sourceDescribe: 'v2.0.0', builtUtc: '2026-07-28T15:04:51.856Z' };
const STORE_B = { kbName: 'beta', sourceCommit: 'bbb222bbb222', sourceDescribe: 'v1.4.0', builtUtc: '2026-07-28T14:59:34.177Z' };
const STORE_B_NEW = { kbName: 'beta', sourceCommit: 'ccc333ccc333', sourceDescribe: 'v1.5.0', builtUtc: '2026-08-02T11:00:00.000Z' };

let server; let origin; let served = { release: null, zip: null };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/releases/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(served.release));
      return;
    }
    if (req.url.startsWith('/bundle.zip')) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(served.zip);
      return;
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

let root; let kbDir;
beforeEach(() => {
  // realpath: on macOS os.tmpdir() is /var/... which is a symlink to /private/var/..., and
  // forge-update.mjs only runs main() when import.meta.url matches argv[1] — an unresolved path
  // silently no-ops the whole script.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-apply-')));
  kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  for (const f of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'kb', f), path.join(kbDir, f));
  }
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A SOURCE.json in the shape this project publishes: bundle identity on top, stores beneath. */
function sourceJson({ releaseTag, brainVersion, builtUtc, stores }) {
  return {
    builder: 'rvf-kb-forge',
    builtUtc,
    brainVersion,
    releaseTag,
    canonicalManifestUrl: `${origin}/releases/latest`,
    stores: Object.fromEntries(stores.map((s) => [s.kbName, { ...s, canonicalManifestUrl: `${origin}/releases/latest` }])),
  };
}

/** Lay a KB down on disk: SOURCE.json plus one .rvf per store, so inventories are comparable. */
function layDown(dir, source) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify(source, null, 2));
  for (const name of Object.keys(source.stores)) fs.writeFileSync(path.join(dir, `${name}.rvf`), Buffer.alloc(512, 7));
}

/** Publish `source` as the single .zip asset of a release tagged `tag`. */
function publish(source, tag) {
  const stage = path.join(root, `stage-${tag}`);
  layDown(stage, source);
  const zipPath = path.join(root, `bundle-${tag}.zip`);
  execFileSync('zip', ['-q', '-r', zipPath, ...fs.readdirSync(stage)], { cwd: stage });
  served.zip = fs.readFileSync(zipPath);
  served.release = {
    tag_name: tag,
    // Later than every store's forge time, exactly as a real Release is — the timestamp path must
    // not be what makes these cases behave, or the test would be measuring the wrong signal.
    published_at: '2026-08-03T00:00:00.000Z',
    assets: [{ name: 'ruvnet-brain-kb-bundle.zip', browser_download_url: `${origin}/bundle.zip` }],
  };
}

/**
 * ASYNC on purpose. The fake release is served from this very process, so a synchronous spawn would
 * block the event loop that has to answer the updater's fetch — the test would deadlock, not fail.
 */
function run(...args) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(kbDir, 'forge-update.mjs'), ...args], {
      cwd: kbDir,
      env: { ...process.env, HOME: home, RUVNET_SETTINGS_FILE: path.join(home, 'nope.json') },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const rollbackCopies = () => fs.readdirSync(root).filter((n) => n.startsWith('kb.bak-'));

describe.skipIf(!CAN_ZIP)('forge-update --apply (issues #106 + #108)', () => {
  it('exits 11 and RELEASES the rollback copy when the download lands an identical bundle (#106 + #108)', async () => {
    // The reported run: the release tag moved, so every store reads BEHIND, but the asset carries
    // the very bundle already on disk. The corpus does not move. Both halves must hold at once —
    // the exit code must not say success, and the 1.6 GB rollback must not be left behind.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.8'); // newer TAG, identical CONTENT

    const { code, out } = await run('--apply');

    expect(code, `nothing landed, so this must not be readable as success\n${out}`).toBe(11);
    expect(out).toMatch(/UPDATE MISMATCH/);
    expect(out).toMatch(/NOT DONE — 0 of 2 store\(s\) moved/);
    expect(rollbackCopies(), 'the rollback copy duplicates an unchanged KB — releasing it is the whole of #108').toEqual([]);
  });

  it('exits 0 and releases the rollback when the bundle moved, even though one store did not (#108)', async () => {
    // 8 of the reporter's 15 stores shared one forge stamp. The first unchanged store in iteration
    // order aborted the entire run; whitelisting it would only promote the next one.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A, STORE_B_NEW],
    }), 'v4.0.8');

    const { code, out } = await run('--apply');

    expect(code, `the bundle genuinely advanced — this run succeeded\n${out}`).toBe(0);
    expect(out).toMatch(/DONE — 2 store\(s\) updated/);
    expect(out, 'an unchanged store is normal and must be named, not inferred from silence').toMatch(/1 of 2 store\(s\) were already at the canonical build[\s\S]*alpha/);
    expect(rollbackCopies()).toEqual([]);
    // And the new bundle really is what is on disk now — read back, not asserted.
    const landed = JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8'));
    expect(landed.releaseTag).toBe('v4.0.8');
    expect(landed.stores.beta.sourceCommit).toBe(STORE_B_NEW.sourceCommit);
  });

  it('treats --restore-complete re-landing the SAME bundle as success, not as "nothing landed"', async () => {
    // That flag exists to bring back artifacts a profile removed, so an unchanged bundle identity
    // is the expected outcome of the request — what it restores is FILES, which SOURCE.json's
    // identity has nothing to say about. Refusing here would break the one path whose whole job is
    // to re-land what is already published.
    const current = sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.8');
    fs.rmSync(path.join(kbDir, 'beta.rvf')); // as a profile would have removed it

    const { code, out } = await run('--apply', '--restore-complete');

    expect(code, out).toBe(0);
    expect(out).toMatch(/DONE — 2 store\(s\) updated/);
    expect(fs.existsSync(path.join(kbDir, 'beta.rvf')), 'the removed artifact must be back').toBe(true);
    expect(rollbackCopies()).toEqual([]);
  });

  it('KEEPS the rollback copy when the copy in place is suspect, rather than releasing it blindly', async () => {
    // "Never strand a resource" must not become "always delete". A landed bundle with no entry for
    // the store we asked about is a wrong/broken copy, and then the rollback is the user's recovery.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_B_NEW],
    }), 'v4.0.8');

    const { code, out } = await run('--apply');

    expect(code, 'a suspect copy is an error, not a no-op').toBe(1);
    expect(out).toMatch(/no entry for store "alpha"/);
    expect(rollbackCopies().length, 'the recovery copy must survive a failed update').toBe(1);
    expect(out, 'and the user must be told where it is').toMatch(/ROLLBACK COPY KEPT/);
  });
});

describe.skipIf(!CAN_ZIP)('forge-update --check (issue #108 bug 2)', () => {
  it('exits 0 for a copy already at the canonical release tag, instead of reporting BEHIND forever', async () => {
    // The release tag is a property of the BUNDLE and is written only at the top level of
    // SOURCE.json, so the per-store `local.releaseTag` isBehind() short-circuits on was always
    // undefined. Every store fell through to a timestamp compare against the RELEASE publish time,
    // which is always later than the forge time of the KB inside it — so all 15 stores read BEHIND
    // on every run, `--check` exited 10 permanently, and `--apply` re-downloaded half a gigabyte
    // nightly to change nothing.
    const current = sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.8');

    const { code, out } = await run('--check');

    expect(code, `already on v4.0.8 — "behind" is not true\n${out}`).toBe(0);
    expect(out).toMatch(/All stores current/);
  });

  it('still exits 10 when the canonical release really is newer', async () => {
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(current, 'v99.0.0'); // synthetic 'newer', never a real release

    const { code, out } = await run('--check');

    expect(code, out).toBe(10);
    expect(out).toMatch(/BEHIND/);
  });
});
