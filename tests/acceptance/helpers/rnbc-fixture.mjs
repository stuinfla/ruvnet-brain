// rnbc-fixture.mjs — an ISOLATED RuvNet Brain Console for click-everything QA (RNBC QA 2026-10-01).
//
// Every root the console or a consumer could write is pointed into one throwaway directory: HOME,
// the console root, the Brain home and KB, the complete-profile bundle, the settings, lesson and
// config stores, the Claude and Codex config dirs. The KB is a two-store fixture (never a private
// store). The global npm bin is removed from PATH so no detector can reach the real ruflo/agentic-*
// binaries, and scheduler work is forced into test mode (plist written under the fake HOME, launchctl
// never called — bin/install.mjs TEST_MODE, nightly-scheduler testMode).
//
// The console is the one a CUSTOMER runs: `npm pack` → the installer's own installConsoleRuntime() →
// `<brainHome>/.console-runtime`. Serving the repository checkout instead hid a whole class of defect:
// the runtime is a copy of CONSOLE_RUNTIME_SURFACE only, and the Nightly switch passed here while every
// installed copy failed for want of bin/nightly-refresh.mjs (RNBC review 2026-10-01).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The fixture brain claims the CURRENT version, derived — a literal goes stale at every release.
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

export const REPO = path.resolve(import.meta.dirname, '../../..');

/** Pack the repository and install the Console runtime from those bytes, exactly as the installer does. */
function installPackedRuntime(root, brainHome, env) {
  const packDir = path.join(root, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const run = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts });
    if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.error?.message}`);
    return r;
  };
  const packed = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: REPO });
  run('tar', ['-xzf', path.join(packDir, JSON.parse(packed.stdout)[0].filename), '-C', packDir]);
  const payload = path.join(packDir, 'package');
  run(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(path.join(payload, 'bin', 'install.mjs')).href)}); m.installConsoleRuntime(${JSON.stringify(brainHome)}, ${JSON.stringify(payload)});`],
  { cwd: root, env: { ...env, RUVNET_BRAIN_IMPORT_ONLY: '1' } });
  return path.join(brainHome, '.console-runtime');
}

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

function kbFixture(dir) {
  json(path.join(dir, 'SOURCE.json'), { stores: {
    ruvector: { kbName: 'ruvector', sourceRepo: 'https://github.com/ruvnet/RuVector' },
    ruflo: { kbName: 'ruflo', sourceRepo: 'https://github.com/ruvnet/ruflo' },
  } });
  json(path.join(dir, 'PRIVATE-STORES.json'), { privateStores: [] });
  for (const [name, size] of [['ruvector.rvf', 4096], ['ruvector.big.rvf', 8192], ['ruflo.rvf', 2048], ['ruflo.big.rvf', 6144]]) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 7));
  }
  write(path.join(dir, 'ruflo.passages.jsonl'), '{"id":1,"text":"fixture"}\n');
  write(path.join(dir, 'forge-mcp-all.mjs'), '// shared reader (fixture)\n');
  // The scheduler refuses to enable without the KB's self-updater present; this stub is never executed
  // (test mode writes the LaunchAgent plist and never calls launchctl).
  write(path.join(dir, 'forge-update.mjs'), '// self-updater stub (fixture) — never run by the QA test\nprocess.exit(0);\n');
  write(path.join(dir, 'capability-cards.md'), '# Capability Cards\n\n## ruflo\nAgent orchestration and memory.\n\n## ruvector\nVector search and RVF storage.\n');
  json(path.join(dir, 'RVF-GENERATIONS.json'), {
    schemaVersion: 2, brainVersion: PACKAGE_VERSION, releaseTag: `v${PACKAGE_VERSION}`,
    stores: {
      ruflo: { file: 'ruflo.big.rvf', sourceCommit: 'aaaaaaa1111111', builtUtc: daysAgo(1), bytes: 6144, model: 'fixture-384' },
      ruvector: { file: 'ruvector.big.rvf', sourceCommit: 'bbbbbbb2222222', builtUtc: daysAgo(2), bytes: 8192, model: 'fixture-384' },
    },
  });
  json(path.join(dir, 'COVERAGE.json'), {
    observedAt: daysAgo(0.1),
    rows: [
      { kind: 'repo', key: 'repo:ruflo', name: 'ruflo', url: 'https://github.com/ruvnet/ruflo', disposition: 'eligible',
        artifact: { store: 'ruflo', sourceCommit: 'aaaaaaa1111111', ingestedAt: daysAgo(1) },
        upstream: { sha: 'aaaaaaa1111111', committedAt: daysAgo(3) } },
      { kind: 'repo', key: 'repo:ruvector', name: 'RuVector', url: 'https://github.com/ruvnet/RuVector', disposition: 'eligible',
        artifact: { store: 'ruvector', sourceCommit: 'bbbbbbb2222222', ingestedAt: daysAgo(2) },
        upstream: { sha: 'ccccccc3333333', committedAt: daysAgo(0.5) } },
      { kind: 'repo', key: 'repo:not-built', name: 'not-built', url: 'https://github.com/ruvnet/not-built', disposition: 'eligible',
        artifact: { store: 'not-built' }, upstream: { sha: 'ddddddd', committedAt: daysAgo(4) } },
      { kind: 'repo', key: 'repo:archived', name: 'archived', url: 'https://github.com/ruvnet/archived', disposition: 'archived' },
      { kind: 'gist', key: 'gist:abc123', name: 'fixture gist', url: 'https://gist.github.com/ruvnet/abc123', disposition: 'eligible',
        artifact: { store: 'ruflo' }, upstream: { updatedAt: daysAgo(5), files: ['notes.md'] } },
    ],
  });
}

function lessonRow(id, { sourceClass, status, enforcement = 'checklist', demoted = false, trigger = 'assert-fact' }) {
  return {
    id, statement: `Fixture rule ${id}: read the live source before stating the fact.`, trigger, enforcement,
    evidence: [{ observed: `fixture evidence for ${id}` }],
    origin: sourceClass === 'current-user' ? 'user-stated' : sourceClass === 'model-inferred' ? 'model-inferred' : 'imported',
    sourceClass, status, ratifiedBy: status === 'candidate' ? null : 'user', demoted, repeatCount: 2,
  };
}

function seedMemoryDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stmts = ['CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, key TEXT, value TEXT, namespace TEXT, updated_at INTEGER, created_at INTEGER, embedding BLOB);'];
  for (let i = 0; i < rows; i++) {
    const key = i === 0 ? `project-state-current-${Date.now()}` : `row-${i}`;
    stmts.push(`INSERT INTO memory_entries(key,value,namespace,updated_at,created_at,embedding) VALUES ('${key}','fixture value ${i}','${i % 2 ? 'patterns' : 'default'}',${Date.now()},${Date.now()},X'01');`);
  }
  const r = spawnSync('sqlite3', [file, stmts.join(' ')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${r.stderr}`);
}

export function buildRnbcFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-qa-')));
  const home = path.join(root, 'home');
  const project = path.join(home, 'Code', 'qa-project');
  const npxProject = path.join(home, 'Code', 'npx-project');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kb = path.join(brainHome, 'kb');
  const bundle = path.join(root, 'complete-bundle');
  const settingsFile = path.join(home, '.config', 'ruvnet-brain', 'settings.json');
  const lessonsFile = path.join(home, '.config', 'ruvnet-brain', 'lessons.json');
  const configFile = path.join(home, '.claude', 'ruvnet-brain', 'config.json');
  for (const d of [project, npxProject, kb, bundle, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });

  kbFixture(kb);
  kbFixture(bundle);
  json(path.join(project, 'package.json'), { name: 'qa-project', private: true });
  seedMemoryDb(path.join(project, '.swarm', 'memory.db'), 12);
  // A project that launches ruflo through npx: the wiring survey must offer a reversible reconcile.
  json(path.join(npxProject, 'package.json'), { name: 'npx-project', private: true });
  json(path.join(npxProject, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npx ruflo@latest hooks pre-command' }] }] } });
  json(lessonsFile, { version: 1, updated: new Date().toISOString(), lessons: [
    lessonRow('QA-ASK', { sourceClass: 'model-inferred', status: 'candidate', trigger: 'claim-done' }),
    lessonRow('QA-ON', { sourceClass: 'current-user', status: 'ratified' }),
    lessonRow('QA-OFF', { sourceClass: 'current-user', status: 'ratified', demoted: true, trigger: 'ship' }),
    lessonRow('QA-IMP-ON', { sourceClass: 'imported-owner', status: 'ratified', trigger: 'write-code' }),
    lessonRow('QA-IMP-CAND', { sourceClass: 'imported-owner', status: 'candidate', trigger: 'write-code' }),
  ] });
  // Two measured routing receipts so the Savings card renders its receipts table.
  write(path.join(brainHome, 'token-ledger.jsonl'), [
    { ts: daysAgo(1), task: 'summarise a diff', model: 'deepseek/deepseek-chat', est_cost: 0.001, est_frontier_cost: 0.05, duration_ms: 900, baseline_duration_ms: 1400 },
    { ts: daysAgo(2), task: 'classify an issue', model: 'deepseek/deepseek-chat', est_cost: 0.002, est_frontier_cost: 0.04, duration_ms: 1200, baseline_duration_ms: 1000 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  // A throwaway SOPS+age identity, so the encrypted OpenRouter-key path is exercised for real.
  const ageKey = path.join(home, '.config', 'sops', 'age', 'keys.txt');
  fs.mkdirSync(path.dirname(ageKey), { recursive: true });
  spawnSync('age-keygen', ['-o', ageKey], { encoding: 'utf8' });
  let pathDirs = String(process.env.PATH || '').split(path.delimiter).filter((p) => p && !/\.npm-global/.test(p));
  // RNBC_HIDE_TOOLS=sops,age,age-keygen reproduces a machine without those tools (the Linux CI runner)
  // on one that has them: each PATH directory holding one is replaced by a shadow of links to the rest.
  const hidden = String(process.env.RNBC_HIDE_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hidden.length) {
    pathDirs = pathDirs.map((dir, i) => {
      if (!hidden.some((tool) => fs.existsSync(path.join(dir, tool)))) return dir;
      const shadow = path.join(root, 'shadow-bin', String(i));
      fs.mkdirSync(shadow, { recursive: true });
      for (const name of fs.readdirSync(dir)) if (!hidden.includes(name)) fs.symlinkSync(path.join(dir, name), path.join(shadow, name));
      return shadow;
    });
  }
  const PATH = pathDirs.join(path.delimiter);
  const env = {
    PATH,
    HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR || os.tmpdir(), LANG: 'en_US.UTF-8',
    RUVNET_CONSOLE_ROOT: home,
    RUVNET_BRAIN_TEST: '1',
    RUVNET_BRAIN_SCHEDULER_TEST: '1',
    RUVNET_BRAIN_HOME: brainHome,
    RUVNET_BRAIN_KB: kb,
    RUVNET_BRAIN_COMPLETE_SOURCE: bundle,
    RUVNET_SETTINGS_FILE: settingsFile,
    RUVNET_LESSON_STORE: lessonsFile,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    RUFLO_DAEMON_AUTOSTART: '0',
    RUVNET_TURN_CAPTURE: 'off',
    SOPS_AGE_KEY_FILE: ageKey,
  };
  // An empty git config: the console shells out to git, and the owner's global config must not shape it.
  const gitConfig = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(gitConfig, '');
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  // The runtime deliberately has no model-identity fallback. This fixture needs the same
  // current catalog asset a configured customer owns; do not depend on the developer's HOME.
  const routerCatalog = path.join(home, '.claude', 'model-router', 'catalog.json');
  fs.mkdirSync(path.dirname(routerCatalog), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'config', 'model-router', 'catalog.template.json'), routerCatalog);
  env.MODEL_ROUTER_CATALOG = routerCatalog;
  const runtime = installPackedRuntime(root, brainHome, env);
  // Every installer run that changes the scheduler — from the console server or any child — appends
  // its argv here, so a test can prove a save did NOT re-run it.
  const nightlyCallLog = path.join(root, 'nightly-calls.log');
  const logger = path.join(root, 'nightly-call-logger.mjs');
  write(logger, `import fs from 'node:fs';\nconst a = process.argv.slice(1);\nif (a.some((x) => x === '--enable-nightly' || x === '--disable-nightly')) fs.appendFileSync(${JSON.stringify(nightlyCallLog)}, a.join(' ') + '\\n');\n`);
  env.NODE_OPTIONS = `--import=${pathToFileURL(logger).href}`;
  const consoleEntry = path.join(runtime, 'scripts', 'onboarding-console.mjs');
  return { root, home, project, npxProject, brainHome, kb, bundle, settingsFile, lessonsFile, configFile, env,
    runtime, nightlyCallLog, console: consoleEntry, consoleDir: path.join(runtime, 'console') };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Pre-warm every cache synchronously, then serve. Background refresh stays ON so /api/refresh is real. */
export async function startRnbc(fx, { warm = true } = {}) {
  if (warm) {
    const r = spawnSync(process.execPath, [fx.console, '--refresh-cache'], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 240_000 });
    if (r.status !== 0) throw new Error(`refresh-cache failed (${r.status}): ${r.stderr}`);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [fx.console, '--serve'], {
    cwd: fx.project, env: { ...fx.env, CONSOLE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`console did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port, url: `http://127.0.0.1:${port}/`, child, output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
    },
  };
}

// A background re-measure the console started can still be writing its cache when the server is
// stopped; under load rmSync then raced it (ENOTEMPTY). Retry the removal instead of failing a run
// whose assertions all passed.
export function cleanupRnbc(fx) { fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }

export const NIGHTLY_LABEL = 'com.ruvnet.brain-update';

/**
 * The nightly job's scheduler entry as THIS platform records it under the fixture HOME, in test mode.
 * macOS: the LaunchAgent plist. Linux / Windows: nightly-scheduler's test-mode adapter keeps the user
 * crontab / the scheduled task in `~/.ruvnet-scheduler-test/<platform>-<label>.json` (the real
 * `crontab` / `schtasks` are never called). A plist assertion on Linux is vacuous — it is always absent.
 * `text` is the entry that owns the label, or null when there is none.
 */
export function schedulerEntry(fx, label = NIGHTLY_LABEL) {
  if (process.platform === 'darwin') {
    const file = path.join(fx.home, 'Library', 'LaunchAgents', `${label}.plist`);
    return { kind: 'LaunchAgent plist', file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
  }
  const file = path.join(fx.home, '.ruvnet-scheduler-test', `${process.platform}-${label}.json`);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const text = process.platform === 'linux'
    ? raw.split('\n').filter((row) => row.trimEnd().endsWith(`# ${label}`)).join('\n')
    : raw;
  return { kind: process.platform === 'linux' ? 'crontab entry' : 'scheduled task', file, text: text || null };
}

/** The scheduler state the installed Console itself reports (its own nightly-controller, fixture env). */
export function schedulerState(fx) {
  const src = `const m = await import(${JSON.stringify(pathToFileURL(path.join(fx.runtime, 'plugin', 'scripts', 'nightly-controller.mjs')).href)});`
    + 'const s = m.nightlyStatus(); process.stdout.write(JSON.stringify({ state: s.state, evidence: s.evidence }));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 60_000 });
  try { return JSON.parse(r.stdout); } catch { return { state: 'unreadable', evidence: `${r.stderr || r.stdout}`.trim().slice(0, 200) }; }
}

/** The registered runner path (empty when nightly was never registered). */
export function registeredRunner(fx) {
  try { return JSON.parse(fs.readFileSync(path.join(fx.brainHome, 'scheduler', 'registration.json'), 'utf8')).runnerPath || ''; } catch { return ''; }
}
