import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '../../..');

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.error?.message}`);
  }
  return result;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the packed Console');
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

export async function installPackedConsole({ prefix, catalog = null, profile = null, decisions = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'brain-packed-console-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'unrelated-project');
  const packDir = path.join(root, 'pack');
  for (const directory of [home, project, packDir]) fs.mkdirSync(directory, { recursive: true });

  const packageRoot = process.env.RUVNET_ACCEPTANCE_PACKAGE_ROOT || REPO;
  const packed = checked('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: packageRoot });
  const tarball = path.join(packDir, JSON.parse(packed.stdout)[0].filename);
  checked('tar', ['-xzf', tarball, '-C', packDir]);
  const payload = path.join(packDir, 'package');

  const routerDir = path.join(home, '.claude', 'model-router');
  if (catalog || profile) fs.mkdirSync(routerDir, { recursive: true });
  if (catalog) fs.writeFileSync(path.join(routerDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  if (profile) fs.writeFileSync(path.join(routerDir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
  if (decisions.length) {
    const decisionDir = path.join(home, '.claude', 'metaharness');
    fs.mkdirSync(decisionDir, { recursive: true });
    fs.writeFileSync(path.join(decisionDir, 'routing-decisions.jsonl'), `${decisions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }

  const cache = path.join(home, '.cache', 'ruvnet-brain');
  const installScript = [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';",
    'const [payload, cache, installRouter] = process.argv.slice(1);',
    "const installer = await import(pathToFileURL(path.join(payload, 'bin', 'install.mjs')).href);",
    'installer.installConsoleRuntime(cache, payload);',
    "if (installRouter === '1') await installer.offerRouterProfile();",
  ].join('');
  checked(process.execPath, ['--input-type=module', '-e', installScript, payload, cache, catalog ? '1' : '0'], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  const entry = path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs');
  const children = new Set();
  let output = '';
  const baseEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RUVNET_CONSOLE_ROOT: home,
    RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1',
  };

  return {
    root,
    home,
    project,
    payload,
    entry,
    installedCatalog: path.join(routerDir, 'catalog.json'),
    measureState() {
      checked(process.execPath, [entry, '--print-state'], { cwd: project, env: baseEnv });
    },
    async start() {
      const port = await freePort();
      const child = spawn(process.execPath, [entry, '--serve'], {
        cwd: project,
        env: { ...baseEnv, CONSOLE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('exit', () => children.delete(child));
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/runtime`);
          return response.ok ? response.json() : null;
        } catch { return null; }
      });
      return { child, port, url: `http://127.0.0.1:${port}/` };
    },
    output: () => output,
    async cleanup() {
      const running = [...children];
      for (const child of running) if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.all(running.map((child) => waitForExit(child)));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function chromeExecutable(chromium) {
  return [
    process.env.PLAYWRIGHT_CHROME_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((candidate) => candidate && fs.existsSync(candidate));
}
