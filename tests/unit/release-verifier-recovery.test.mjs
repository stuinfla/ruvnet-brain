import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rpcSearch, tarExtractionInvocation } from '../../scripts/publication-receipt.mjs';
import { ALLOWED_TRANSITIONS, abortReleaseTransaction, signReceipt, validateReceiptChain, receiptDisposition } from '../../scripts/release-transaction.mjs';
import { FakeReleaseProvider, identity, keys, transactionId } from '../helpers/release-transaction-fixture.mjs';
import { npxInvocation } from '../../scripts/published-surface-probe.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function server({ text = 'repo=other-repo path: src/answer.mjs', delay = 0, error = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-recovery-'));
  roots.push(root);
  const file = path.join(root, 'server.mjs');
  const stopped = path.join(root, 'stopped');
  const pidFile = path.join(root, 'pid');
  fs.writeFileSync(file, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0);
    }, ${delay}));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const result = request.method === 'tools/list' ? { tools: [{ name: 'search_ruvnet' }] }
        : request.method === 'tools/call' ? { isError: ${error}, content: [{ type: 'text', text: ${JSON.stringify(text)} }] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  return { file, stopped, pidFile };
}

describe('public release recovery regressions', () => {
  it('accepts other-repository transport citations without weakening the self probe', async () => {
    const fixture = server();
    await expect(rpcSearch(fixture.file, process.env, 'query', 10, 2000)).rejects.toThrow(/ruvnet-brain/);
    await expect(rpcSearch(fixture.file, process.env, 'query', 10, 2000, { requiredRepo: null }))
      .resolves.toMatchObject({ text: 'repo=other-repo path: src/answer.mjs' });
  });
  it('waits for child shutdown before success or failure reaches the next probe', async () => {
    for (const error of [false, true]) {
      const fixture = server({ text: 'repo=ruvnet-brain path: src/answer.mjs', delay: 150, error });
      const result = rpcSearch(fixture.file, process.env, 'query', 10, 2000);
      if (error) await expect(result).rejects.toThrow(/search failed/);
      else await result;
      const pid = Number(fs.readFileSync(fixture.pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      // Windows terminates directly; it does not deliver JS SIGTERM handlers.
      // POSIX additionally proves the delayed handler finished before resolution.
      if (process.platform !== 'win32') expect(fs.existsSync(fixture.stopped)).toBe(true);
    }
  });
  it('passes a local archive name to either GNU or BSD tar on Windows', () => {
    expect(tarExtractionInvocation('C:\\temp\\package.tgz', 'D:\\install', { platform: 'win32' }))
      .toEqual({ args: ['-xzf', './package.tgz', '-C', 'D:\\install'], cwd: 'C:\\temp' });
  });
  it('restores an explicitly authorized unsuccessful exit from manual intervention', () => {
    expect(ALLOWED_TRANSITIONS['manual-intervention-required']).toEqual(['aborted']);
  });
  it('preserves authorization and prior-default checks when closing a signed manual intervention chain', async () => {
    const provider = new FakeReleaseProvider();
    const first = signReceipt({ schemaVersion: 3, transactionId, sequence: 0,
      previousReceiptDigest: null, state: 'remote-prepared', identity,
      observation: { prior: { npmLatest: '9.9.8', githubLatest: 'v9.9.8' } }, createdAt: 'then' }, keys.privateKey);
    const blocked = signReceipt({ schemaVersion: 3, transactionId, sequence: 1,
      previousReceiptDigest: first.receiptDigest, state: 'manual-intervention-required', identity,
      observation: {}, createdAt: 'now' }, keys.privateKey);
    provider.receipts = [first, blocked];
    const args = { identity, receipts: provider.receipts, reason: 'explicit recovery', adapter: provider,
      privateKey: keys.privateKey, publicKey: keys.publicKey };
    await expect(abortReleaseTransaction({ ...args, authorized: false })).rejects.toThrow(/authorization/);
    provider.npmLatest = identity.version;
    await expect(abortReleaseTransaction({ ...args, authorized: true })).rejects.toThrow(/prior generation/);
    provider.npmLatest = '9.9.8';
    const closed = await abortReleaseTransaction({ ...args, authorized: true });
    expect(receiptDisposition(closed)).toBe('closed-unsuccessful');
    expect(validateReceiptChain(provider.receipts, identity, keys.publicKey).at(-1)).toEqual(closed);
    await expect(abortReleaseTransaction({ ...args, authorized: true })).rejects.toThrow(/not abortable/);
  });
  it('executes the Windows npx command shim through its command processor', () => {
    expect(npxInvocation(['-y', 'ruvnet-brain@latest', '--help'], { platform: 'win32', env: {} }))
      .toEqual({ executable: 'cmd.exe', args: ['/d', '/c', 'npx.cmd', '-y', 'ruvnet-brain@latest', '--help'] });
    expect(npxInvocation(['--version'], { platform: 'linux' }))
      .toEqual({ executable: 'npx', args: ['--version'] });
  });
  it('loads the stale-abort operator and refuses an unspecified target before external reads', () => {
    const result = spawnSync(process.execPath, ['scripts/release-abort-stale.mjs'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--tag <vX.Y.Z> is required');
    expect(result.stderr).not.toContain('does not provide an export');
  });
});
