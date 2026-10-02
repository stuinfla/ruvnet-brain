import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
it('the installer retries an interrupted transfer and still refuses an invalid signature', async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installer-retry-')));
  let bundles = 0;
  let signatures = 0;
  const bytes = Buffer.from('complete but unsigned archive');
  const server = http.createServer((req, res) => {
    if (req.url === '/manifest') {
      res.end(JSON.stringify({ tag_name: 'v99.0.0', assets: [{ name: 'ruvnet-brain.zip',
        browser_download_url: 'https://fixture.invalid/bundle.zip' }] }));
    } else if (req.url === '/bundle') {
      bundles++;
      res.writeHead(200, { 'content-length': bytes.length });
      if (bundles === 1) {
        res.write(bytes.subarray(0, 5));
        setImmediate(() => res.destroy());
      } else res.end(bytes);
    } else if (req.url === '/signature') {
      signatures++;
      res.end(Buffer.alloc(64));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const preload = path.join(scratch, 'network.mjs');
  // Redirect only transport to a real local server; the installer, stream handling and signature
  // verifier execute unchanged. Any unanticipated network request fails the test immediately.
  fs.writeFileSync(preload, `import https from 'node:https'; import http from 'node:http';
https.get = (url, options, callback) => {
  const text = String(url);
  const route = text.endsWith('/releases/latest') ? '/manifest'
    : text === 'https://fixture.invalid/bundle.zip' ? '/bundle'
    : text === 'https://fixture.invalid/bundle.zip.sig' ? '/signature' : null;
  if (!route) throw new Error('unexpected network: ' + text);
  return http.get('http://127.0.0.1:${server.address().port}' + route, options, callback);
};`);
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  try {
    const child = spawn(process.execPath, ['--import', preload, path.join(root, 'bin/install.mjs'),
      '--force', '--yes', '--no-nightly-prompt', '--no-telemetry'],
    { cwd: scratch, env: { ...process.env, HOME: home, RUVNET_BRAIN_KB: path.join(home, 'kb'),
      RUVNET_BRAIN_HOME: path.join(home, 'brain'), XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
      XDG_STATE_HOME: path.join(home, 'state'), RUVNET_TURN_CAPTURE: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (part) => output += part); child.stderr.on('data', (part) => output += part);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    expect(bundles, output).toBe(2);
    expect(signatures, output).toBe(1);
    expect(status, output).toBe(1);
    expect(output).toMatch(/signature.*(?:failed|invalid|match)|SIGNATURE VERIFICATION FAILED/i);
    expect(fs.existsSync(path.join(home, 'kb', 'forge-mcp-all.mjs'))).toBe(false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 25_000);
