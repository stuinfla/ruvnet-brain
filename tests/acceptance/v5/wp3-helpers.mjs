// Work package 3 (health) test harness. Every wp3 test runs on a scratch tree (helpers.setup) so a
// V5_BREAK patch reaches it. Since wave 2 the package is wired into the shipped entry points (the
// hook file imports health/hook.mjs; the CLI's doctor and status and the installer's real-server
// check use doctor.mjs, line.mjs and assess.mjs), so the tree is used as it is.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, sleeper } from './helpers.mjs';

export const DAY = 86_400_000;
export const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Scratch tree with the wiring applied, plus an importer for the tree's own health modules. */
export function wp3(t, testId) {
  const ctx = setup(t, testId);
  const tree = ctx.tree();
  const procs = [];
  t.after(() => procs.forEach((p) => p.kill()));
  const mod = (name) => import(pathToFileURL(path.join(tree.root, 'packages', 'health', name)).href);

  /** A live process id (not a server) whose status file we write by hand. */
  const livePid = () => {
    const p = sleeper();
    procs.push(p);
    return p.pid;
  };
  const deadPid = async () => {
    const p = sleeper();
    await new Promise((r) => {
      p.on('exit', r);
      p.kill();
    });
    return p.pid;
  };

  /**
   * A brain home written by hand: current.json and the pack's PACK.json (when installed), status
   * files, update.json, update-check.json, config.json. Returns the home path.
   */
  function home({ installed = true, knowledgeDate = '2026-11-14', releaseNumber = 1, servers = [], update = null, updateCheck = null, config = {} } = {}) {
    const h = ctx.tmp('rb5-wp3-home-');
    const w = (rel, v) => {
      fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true });
      fs.writeFileSync(path.join(h, rel), JSON.stringify(v));
    };
    if (installed) {
      w('current.json', { schema: 'ruvnet-brain/current', version: 1, app: '5.0.0-wp3', pack: 'g-wp3', releaseNumber, previous: null, switchedAt: new Date().toISOString() });
      w('packs/g-wp3/PACK.json', { knowledgeDate });
    }
    for (const s of servers) w(`state/status/${s.pid}.json`, s);
    if (update) w('state/update.json', update);
    if (updateCheck) w('state/update-check.json', updateCheck);
    w('state/config.json', config);
    return h;
  }
  return { ctx, tree, mod, livePid, deadPid, home };
}

/** A healthy status file at `now`, with overrides. */
export function status(pid, now = Date.now(), over = {}) {
  return {
    schema: 'ruvnet-brain/status', version: 1, pid, startedAt: now - 60_000, heartbeatAt: now, app: '5.0.0-wp3', pack: 'g-wp3', knowledgeDate: '2026-11-14',
    lanes: [{ name: 'lexical', available: true }],
    probe: { ok: true, at: now - 30_000, failingSince: null, error: null, results: [{ question: 'hnsw index', expect: 'alpha-vectors/README.md', pass: true, top: 'alpha-vectors/README.md' }] },
    lastSearch: null,
    ...over,
  };
}

export const failedProbe = (now, error = 'a probe did not find its expected file') => ({ ok: false, at: now - 20_000, failingSince: now - 20_000, error, results: [{ question: 'hnsw index', expect: 'alpha-vectors/README.md', pass: false, top: null }] });
