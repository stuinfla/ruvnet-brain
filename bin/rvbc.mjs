#!/usr/bin/env node
/**
 * rvbc — One-command launcher for the RuvNet Brain Console (http://127.0.0.1:7411/).
 * Works from any terminal, Claude Code, Codex, or Antigravity without memorizing URLs or paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.RUVNET_CONSOLE_PORT || 7411);
const URL = `http://127.0.0.1:${PORT}/`;

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* user still sees URL on stdout */ }
}

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/runtime', timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function resolveConsoleScript() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'scripts', 'onboarding-console.mjs'),
    path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb', '.console-runtime', 'scripts', 'onboarding-console.mjs'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const noOpen = process.argv.includes('--no-open');
const running = await probe();
if (running && running.product === 'ruvnet-brain-console') {
  console.log(`RuvNet Brain Console v${running.runtimeVersion || '?'} is running at ${URL} (pid ${running.pid})`);
  if (!noOpen) openBrowser(URL);
  process.exit(0);
}

const script = resolveConsoleScript();
if (!script) {
  console.error('Could not locate onboarding-console.mjs. Run `ruvnet-brain --update` first.');
  process.exit(1);
}

const child = spawn(process.execPath, [script, '--serve', '--port', String(PORT)], {
  cwd: process.cwd(),
  detached: true,
  stdio: 'ignore',
});
child.unref();

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const ready = await probe();
  if (ready && ready.product === 'ruvnet-brain-console') {
    console.log(`Started RuvNet Brain Console v${ready.runtimeVersion || '?'} at ${URL} (pid ${ready.pid})`);
    if (!noOpen) openBrowser(URL);
    process.exit(0);
  }
}

console.error(`Console did not become ready on ${URL}. Try: node "${script}"`);
process.exit(1);
