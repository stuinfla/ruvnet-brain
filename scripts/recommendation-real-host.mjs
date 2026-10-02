#!/usr/bin/env node
/**
 * recommendation-real-host.mjs — the package recommender in a REAL Claude Code session (ADR-093 rev 3).
 *
 * For each selected eval prompt: a fresh `claude -p` with this checkout's UserPromptSubmit runtime as
 * its only hook (route producer only, flag on), a warm search worker in a throwaway brain home, then the
 * model's actual answer. Records whether the hook injected a hint, which packages it carried, and which
 * one (if any) the model named — so the simulated-host judge can be checked against a real host.
 *
 * Isolation, following scripts/hook-qualify-hosts.mjs: --no-session-persistence, --setting-sources ''
 * (no user/project settings, plugins or hooks), --strict-mcp-config (no MCP servers), --tools '' (no
 * tool can touch anything), a temp cwd, every RUVNET_* state path in a temp dir. Auth is the user's own
 * login; the run snapshots ~/.claude mtimes before/after and reports anything that changed.
 *
 *   node scripts/recommendation-real-host.mjs --key <e2e judge-key.json> --models <d> --xenova <d> --out <dir>
 *        [--n-pos 12 --n-neg-hinted 6 --n-other 4 | --all-blinds] [--max-load 60 --batch 11] [--claude <bin>]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CLAUDE = arg('--claude', path.join(os.homedir(), '.npm-global', 'bin', 'claude'));
const POS = new Set(['design', 'diagnosis']);

/** Deterministic stratified sample from the blind sets of an e2e key. */
export function stratify(key, { nPos = 12, nNegHinted = 6, nOther = 4, floor = 0 } = {}) {
  const hinted = (k) => k.lane && (k.lane !== 'semantic' || k.topSimilarity >= floor);
  const blind = key.filter((k) => /blind/.test(k.set)).sort((a, b) => a.qid.localeCompare(b.qid));
  const every = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]));
  const pos = every(blind.filter((k) => POS.has(k.category) && hinted(k)), nPos);
  const negHinted = every(blind.filter((k) => !POS.has(k.category) && hinted(k)), nNegHinted);
  const other = every(blind.filter((k) => !hinted(k)), nOther);
  return [...pos, ...negHinted, ...other];
}

/** Which offered package (by full id or short name) the answer names, if any. Pure. */
export function mentioned(answer, offered) {
  const text = String(answer || '');
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const id of offered || []) {
    const short = id.replace(/^@[^/]+\//, '');
    const re = (s) => new RegExp(`(?<![\\w@/-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'i');
    // A scoped or hyphenated id is unambiguous anywhere. A bare short name ("migration", "typesafe")
    // counts only in a sentence that also names rUv — "write the migration" is not a recommendation.
    if (re(id).test(text) && (id.startsWith('@') || id.includes('-'))) return id;
    if (sentences.some((s) => /\brUv\b|ruvector|ruvnet/i.test(s) && (re(id).test(s) || (short.length >= 5 && re(short).test(s))))) return id;
  }
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outDir = arg('--out', null);
  if (!outDir || !arg('--key', null)) { console.error('--key and --out are required'); process.exit(2); }
  const key = JSON.parse(fs.readFileSync(arg('--key'), 'utf8'));
  const items = new Map();
  for (const f of ['recommendation-eval.blind.v1.json', 'recommendation-eval.blind.v2.json']) {
    for (const it of JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', f), 'utf8')).items) items.set(`${f}:${it.id}`, it);
  }
  // --all-blinds: every blind prompt, in qid order (the decision run); otherwise the stratified sample.
  const sample = process.argv.includes('--all-blinds')
    ? key.filter((k) => /blind/.test(k.set)).sort((a, b) => a.qid.localeCompare(b.qid))
    : stratify(key, { nPos: Number(arg('--n-pos', 12)), nNegHinted: Number(arg('--n-neg-hinted', 6)), nOther: Number(arg('--n-other', 4)), floor: Number(arg('--floor', 0.532)) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-host-'));
  const kb = path.join(home, 'kb'); fs.mkdirSync(kb);
  const cwd = path.join(home, 'cwd'); fs.mkdirSync(cwd);
  const marker = path.join(home, 'marker'); fs.writeFileSync(marker, '');
  const brainEnv = { RUVNET_BRAIN_HOME: home, KB_DIR: kb, KB_MODEL_CACHE: arg('--models', ''), XENOVA_PATH: arg('--xenova', '') };
  const worker = spawn(process.execPath, [path.join(ROOT, 'kb', 'forge-mcp-all.mjs')],
    { env: { PATH: process.env.PATH, HOME: home, ...brainEnv, RUVNET_PACKAGE_RECOMMENDER: '1', RUVNET_BRAIN_IDLE_EXIT_MS: '0' }, stdio: ['pipe', 'pipe', 'ignore'] });   // idle exit off: load-gate waits must not retire the worker mid-run
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { worker.kill('SIGTERM'); fs.rmSync(home, { recursive: true, force: true }); process.exit(1); });
  const rl = readline.createInterface({ input: worker.stdout });
  const waiters = new Map();
  rl.on('line', (l) => { try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch { /* not ours */ } });
  const call = (id, method) => new Promise((r) => { waiters.set(id, r); worker.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`); });
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ autoMemoryEnabled: false, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${path.join(ROOT, 'plugin', 'scripts', 'unprompted-runtime.mjs')}" UserPromptSubmit`, timeout: 3 }] }] } }));
  const rows = [];
  try {
    await call(1, 'initialize');
    const warm = await call(2, 'brain/warmup');
    if (!warm.result?.ready) throw new Error('worker warmup failed');
    // LOAD GATE: never start a batch while the 1-minute load is above --max-load; wait (polling) instead.
    // Each row records the load it ran at, so delivery can be read against load afterwards.
    const maxLoad = Number(arg('--max-load', 1e9));
    const batch = Number(arg('--batch', 11));
    const waitForLoad = async () => {
      let waited = 0;
      while (os.loadavg()[0] > maxLoad) { await new Promise((res) => setTimeout(res, 20_000)); waited += 20; }
      if (waited) console.log(`[load-gate] waited ${waited}s for load < ${maxLoad}`);
    };
    for (const [n, k] of sample.entries()) {
      if (n % batch === 0) await waitForLoad();
      const it = items.get(`${k.set}:${k.id}`);
      const env = {
        ...process.env, ...brainEnv, CLAUDE_HOOK: '/usr/bin/true', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', RUVNET_PACKAGE_RECOMMENDER: '1',
        RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify([{ argv: [process.execPath, path.join(ROOT, 'plugin', 'scripts', 'advocacy-route.mjs')], feedStdin: true, channels: ['advocacy'] }]),
        RUVNET_ADVOCACY_ROUTE_STATE: path.join(home, `state-${n}.json`), RUVNET_ADVOCACY_OUTCOMES: path.join(home, `outcomes-${n}.jsonl`),
        RUVNET_ADVOCACY_ROUTE_ROOTS: path.join(home, 'none'), RUVNET_SETTINGS_FILE: path.join(home, 'user-settings.json'),
      };
      const r = spawnSync(CLAUDE, ['-p', it.prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
        '--no-session-persistence', '--setting-sources', '', '--settings', settings, '--strict-mcp-config', '--tools', '',
        '--max-turns', '1', '--max-budget-usd', '0.30',
        '--append-system-prompt', 'This is a quick planning exchange with no tools: answer in at most five sentences with how you would approach the request.'],
      { cwd, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64e6 });
      let injected = ''; let answer = '';
      for (const line of String(r.stdout || '').split('\n')) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        const blob = JSON.stringify(o);
        // All three advocacy copies: the package lanes AND the closed catalogue ("capability advocacy").
        const m = blob.match(/\[RuvNet Brain — (?:rUv (?:may already ship|already ships) this|capability advocacy)\][^"]*/);
        if (m && !injected) injected = m[0];
        if (o.type === 'result' && typeof o.result === 'string') answer = o.result;
      }
      const offered = injected ? [...new Set([...injected.matchAll(/(?:Consider )?(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]+) — /gi)].map((x) => x[1]))] : [];
      rows.push({ qid: k.qid, set: k.set, id: k.id, category: k.category, load1m: +os.loadavg()[0].toFixed(1), exit: r.status, injected: Boolean(injected), offered, said: mentioned(answer, offered), answer: answer.slice(0, 1200) });
      console.log(`${k.qid} ${k.category.padEnd(9)} hint=${injected ? 'yes' : 'no '} said=${rows.at(-1).said || '-'}`);
    }
  } finally {
    worker.kill('SIGTERM');
    // Other sessions write under ~/.claude all the time; what THIS run could own is a project entry for
    // its own temp cwd, so that is checked by name as well as the raw mtime list.
    const ours = [path.join(os.homedir(), '.claude', 'projects')].flatMap((d) => { try { return fs.readdirSync(d).filter((n) => n.includes('reco-host')); } catch { return []; } });
    let inDotClaudeJson = false; try { inDotClaudeJson = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8').includes(path.basename(home)); } catch { /* absent */ }
    const touched = spawnSync('find', [path.join(os.homedir(), '.claude'), '-newer', marker, '-maxdepth', '3'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'real-host.json'), JSON.stringify({ claude: spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' }).stdout.trim(), sample: rows.length, projectEntriesForThisRun: ours, cwdRecordedInDotClaudeJson: inDotClaudeJson, modifiedUnderDotClaudeByAnyProcess: touched.length, rows }, null, 1));
    console.log(`project entries for this run under ~/.claude/projects: ${ours.length}; temp cwd in ~/.claude.json: ${inDotClaudeJson}; ~/.claude entries modified by ANY process meanwhile: ${touched.length}`);
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
}
