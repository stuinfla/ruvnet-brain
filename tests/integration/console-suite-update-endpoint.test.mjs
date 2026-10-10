import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const ROOT = path.resolve(import.meta.dirname, '../..');
let child, home, port, token;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-update-endpoint-'));
  port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  child = spawn(process.execPath, [path.join(ROOT, 'scripts/onboarding-console.mjs'), '--serve'], {
    cwd: ROOT, env: { ...process.env, CONSOLE_PORT: String(port), RUVNET_CONSOLE_ROOT: home, RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain'), RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error(`console did not start: ${output}`)), 15_000);
    child.stdout.on('data', chunk => { output += chunk; if (/http:\/\/127\.0\.0\.1:\d+\//.test(output)) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject); child.once('exit', code => { if (code) { clearTimeout(timer); reject(Error(output)); } });
  });
  const page = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
  token = page.match(/window\.__CONSOLE_TOKEN__=\"([a-f0-9]{48})\"/)?.[1]; expect(token).toBeTruthy();
});
afterAll(async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } fs.rmSync(home, { recursive: true, force: true }); });
const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/suite-update`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
describe('authenticated coordinator endpoint', () => {
  it('reads live status without inventing a completed run or writing a policy', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/suite-update`);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'never-run', active: false, channel: 'latest' });
    expect(fs.existsSync(path.join(home, '.cache/ruvnet-brain/developer-update-config.json'))).toBe(false);
  });
  it('rejects an absent action token and cross-origin action', async () => {
    expect((await post({ channel: 'latest' })).status).toBe(403);
    expect((await post({ token, channel: 'latest' }, { origin: 'https://untrusted.example' })).status).toBe(403);
  });
  it('rejects an invalid policy without invoking the updater', async () => {
    expect((await post({ token, channel: 'beta' })).status).toBe(400);
    expect(fs.existsSync(path.join(home, '.cache/ruvnet-brain/developer-update-config.json'))).toBe(false);
  });
  it('joins no second updater while the shared coordinator lock is active', async () => {
    const directory = path.join(home, '.cache/ruvnet-brain/developer-update.lock'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'fixture-owned-update-token' }));
    expect((await post({ token, channel: 'latest' })).status).toBe(409);
    expect(fs.existsSync(path.join(home, '.cache/ruvnet-brain/developer-update-config.json'))).toBe(false);
  });
});
