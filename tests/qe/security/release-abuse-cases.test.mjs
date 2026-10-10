import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractZip, ZIP_LIMITS } from '../../../kb/zip-extract.mjs';
import { verifyBundle } from '../../../scripts/verify-bundle.mjs';
import { checkCoexistence } from '../../../scripts/selfcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UPDATE = path.join(ROOT, 'scripts', 'update-apply.mjs');
const HOST_UPDATE = path.join(ROOT, 'plugin', 'scripts', 'host-update.mjs');
const garbage = [];
const temporary = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  garbage.push(dir);
  return dir;
};
afterEach(() => {
  while (garbage.length) fs.rmSync(garbage.pop(), { recursive: true, force: true });
});

function payload(version, { broken = false } = {}) {
  const dir = temporary('rvb-qe-payload-');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, '.claude-plugin'));
  fs.writeFileSync(path.join(dir, 'scripts', 'body.mjs'), broken ? 'const = nope' : 'console.log("ok")');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return dir;
}
function runUpdate(home, ...args) {
  return spawnSync(process.execPath, [UPDATE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RUVNET_BRAIN_HOME: home, CLAUDE_PLUGIN_ROOT: '' },
  });
}
function oneFileZip({ name = 'payload.bin', actual, claimed = actual.length }) {
  const compressed = zlib.deflateRawSync(actual);
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(claimed, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(claimed, 24);
  central.writeUInt16LE(filename.length, 28);
  const cdOffset = local.length + filename.length + compressed.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + filename.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, filename, compressed, central, filename, eocd]);
}

describe('Stable Spine hostile payloads', () => {
  it.each(['../../escape', '../escape', '/absolute', 'x/y', 'x\\\\y', '$(touch pwned)', 'x;touch pwned'])(
    'rejects unsafe version %j without changing the active generation',
    (version) => {
      const home = temporary('rvb-qe-spine-');
      const r = runUpdate(home, '--from-dir', payload(version));
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(path.join(home, 'active.json'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')('rejects nested and root payload symlinks', () => {
    const home = temporary('rvb-qe-spine-');
    const outside = path.join(temporary('rvb-qe-outside-'), 'secret');
    fs.writeFileSync(outside, 'secret');
    const nested = payload('1.2.3');
    fs.symlinkSync(outside, path.join(nested, 'scripts', 'secret-link'));
    expect(runUpdate(home, '--from-dir', nested).status).not.toBe(0);
    const rootLink = path.join(temporary('rvb-qe-link-'), 'payload');
    fs.symlinkSync(payload('1.2.4'), rootLink);
    expect(runUpdate(home, '--from-dir', rootLink).status).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked versions control directory', () => {
    const home = temporary('rvb-qe-spine-');
    const outside = temporary('rvb-qe-versions-outside-');
    fs.symlinkSync(outside, path.join(home, 'versions'));
    const r = runUpdate(home, '--from-dir', payload('1.2.3'));
    expect(r.status).not.toBe(0);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(home, 'active.json'))).toBe(false);
  });

  it('keeps the verified prior generation active after an interrupted/broken candidate', () => {
    const home = temporary('rvb-qe-spine-');
    expect(runUpdate(home, '--from-dir', payload('1.2.3')).status).toBe(0);
    expect(runUpdate(home, '--from-dir', payload('1.2.4', { broken: true })).status).not.toBe(0);
    const active = JSON.parse(fs.readFileSync(path.join(home, 'active.json'), 'utf8'));
    expect(active.version).toBe('1.2.3');
  });
});

describe('archive fault injection', () => {
  it('publishes finite resource ceilings', () => {
    for (const value of Object.values(ZIP_LIMITS)) expect(Number.isSafeInteger(value) && value > 0).toBe(true);
  });

  it('rejects a high-ratio archive before creating its destination', async () => {
    const zip = path.join(temporary('rvb-qe-zip-'), 'bomb.zip');
    fs.writeFileSync(zip, oneFileZip({ actual: Buffer.alloc(4 * 1024 * 1024, 0x41) }));
    const dest = path.join(temporary('rvb-qe-dest-parent-'), 'dest');
    await expect(extractZip(zip, dest)).rejects.toThrow(/compression ratio.*safety limit/i);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('aborts deceptive expansion and removes the partial output', async () => {
    const zip = path.join(temporary('rvb-qe-zip-'), 'lying.zip');
    fs.writeFileSync(zip, oneFileZip({ actual: crypto.randomBytes(1024 * 1024), claimed: 16 }));
    const dest = path.join(temporary('rvb-qe-dest-parent-'), 'dest');
    await expect(extractZip(zip, dest)).rejects.toThrow(/safety limit|failed to inflate/i);
    expect(fs.existsSync(path.join(dest, 'payload.bin'))).toBe(false);
    expect(fs.existsSync(dest) ? fs.readdirSync(dest).some((x) => x.includes('.ruvnet-extract-')) : false).toBe(false);
  });
});

describe('provenance, secrets, and foreign hooks', () => {
  it('fails closed for missing, wrong-key, and tampered signatures', () => {
    const dir = temporary('rvb-qe-sign-');
    const bundle = path.join(dir, 'bundle.zip');
    fs.writeFileSync(bundle, 'trusted bytes');
    const signer = crypto.generateKeyPairSync('ed25519');
    const stranger = crypto.generateKeyPairSync('ed25519');
    const pub = path.join(dir, 'pub.pem');
    fs.writeFileSync(pub, signer.publicKey.export({ type: 'spki', format: 'pem' }));
    const sig = path.join(dir, 'bundle.sig');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest();
    fs.writeFileSync(sig, crypto.sign(null, digest, signer.privateKey));
    expect(verifyBundle(bundle, sig, pub).ok).toBe(true);
    fs.writeFileSync(bundle, 'tampered');
    expect(verifyBundle(bundle, sig, pub).ok).toBe(false);
    fs.writeFileSync(pub, stranger.publicKey.export({ type: 'spki', format: 'pem' }));
    expect(verifyBundle(bundle, sig, pub).ok).toBe(false);
    expect(verifyBundle(bundle, path.join(dir, 'missing.sig'), pub).ok).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not forward API keys or cloud credentials to downloaded updater code', () => {
    const dir = temporary('rvb-qe-env-');
    const capture = path.join(dir, 'captured.json');
    const npx = path.join(dir, '.npm-global', 'bin', 'npx');
    fs.mkdirSync(path.dirname(npx), { recursive: true });
    fs.writeFileSync(npx, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env));\n`);
    fs.chmodSync(npx, 0o755);
    const r = spawnSync(process.execPath, [HOST_UPDATE], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        OPENROUTER_API_KEY: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, '.codex'),
        RUVNET_BRAIN_HOME: path.join(dir, 'safe', 'brain-home'),
      },
    });
    expect(r.status).toBe(0);
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(seen.OPENROUTER_API_KEY).toBeUndefined();
    expect(seen.GITHUB_TOKEN).toBeUndefined();
    expect(seen.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(seen.RUVNET_BRAIN_HOME).toBe(path.join(dir, 'safe', 'brain-home'));
    expect(seen.HOME).toBe(dir);
  });

  it('enumerates hostile foreign hooks as data and never executes them', async () => {
    const home = temporary('rvb-qe-hooks-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const canary = path.join(home, 'executed');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `${process.execPath} -e "require('fs').writeFileSync('${canary}','x')"` }] }] },
    }));
    const result = await checkCoexistence({ home, repo: ROOT });
    expect(result.foreign.length).toBeGreaterThan(0);
    expect(fs.existsSync(canary)).toBe(false);
  });
});
