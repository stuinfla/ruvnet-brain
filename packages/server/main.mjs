// The MCP server (architecture 2.2): one stable process per session, newline-delimited JSON-RPC on
// stdio, tool `search_ruvnet`. Searches run in a worker thread under the recipe's deadline; when the
// worker dies or runs out of time the main thread answers from the keyword lane ("safe mode").
// Before every call the pointer file is re-read, so a new app or pack is picked up without a restart.
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { paths, readConfig, readJson, readPointer } from '../contract/home.mjs';
import { removeStatus, writeStatus } from '../health/status.mjs';
import { createRunner } from './runner.mjs';
import { format } from './format.mjs';

const TOOL = {
  name: 'search_ruvnet',
  description: "Search RuvNet Brain's signed knowledge pack of rUv's public work. Returns cited passages in sections (FILES), each with repository, path, lines, commit, standing and date.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The problem or question, in plain words.' },
      detail: { type: 'string', enum: ['brief', 'full'], description: 'brief (default) or full: longer excerpts.' },
      k: { type: 'number', description: 'Ignored in version 5; use detail.' },
    },
    required: ['query'],
  },
};

const importFrom = (dir, ...rel) => import(pathToFileURL(path.join(dir, ...rel)).href);

export async function run({ home, input = process.stdin, output = process.stdout }) {
  const cfg = readConfig(home);
  const now = Date.now();
  const status = { schema: 'ruvnet-brain/status', version: 1, pid: process.pid, startedAt: now, heartbeatAt: now, app: null, pack: null, knowledgeDate: null, lanes: [], probe: null, lastSearch: null };
  const save = () => {
    status.heartbeatAt = Date.now();
    try {
      writeStatus(home, status);
    } catch {}
  };
  let active = null;
  let busy = false;
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(async () => {
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    });
    chain = p.catch(() => {});
    return p;
  };

  function ensureActive() {
    const ptr = readPointer(home);
    if (!ptr) throw new Error('RuvNet Brain 5 is not installed (no current.json); run: ruvnet-brain install');
    if (!active || active.app !== ptr.app || active.pack !== ptr.pack) {
      active?.runner.terminate();
      if (active?.safe) active.safeEngine.close(active.safe);
      const appDir = path.join(paths(home).app, ptr.app);
      const packDir = path.join(paths(home).packs, ptr.pack);
      const pack = readJson(path.join(packDir, 'PACK.json'));
      const recipe = readJson(path.join(packDir, pack.files.find((f) => f.role === 'recipe').path));
      active = { app: ptr.app, pack: ptr.pack, appDir, packDir, recipe, runner: createRunner(appDir, packDir), probed: false };
      Object.assign(status, { app: ptr.app, pack: ptr.pack, knowledgeDate: pack.knowledgeDate, probe: null, lastSearch: null });
    }
    return active;
  }

  async function probe() {
    const at = Date.now();
    let t;
    try {
      const a = ensureActive();
      a.runner.terminate(); // a fresh worker opens the index again, so damage on disk is seen
      t = await a.runner.call({ type: 'selfTest' }, a.recipe.deadlineMs);
      a.probed = true;
    } catch (e) {
      t = { ok: false, error: e.message, results: [] };
    }
    const failingSince = t.ok ? null : status.probe && !status.probe.ok ? status.probe.failingSince : at;
    status.probe = { ok: t.ok, at, failingSince, error: t.error ?? (t.ok ? null : 'a probe did not find its expected file'), results: t.results };
    if (t.lanes) status.lanes = t.lanes;
    save();
  }

  async function safeMode(a, query, detail, reason) {
    if (!a.safe) {
      a.safeEngine = await importFrom(a.appDir, 'engine', 'index.mjs');
      a.safe = a.safeEngine.open(a.packDir);
    }
    const r = a.safeEngine.search(a.safe, query, { detail, lanes: ['lexical'] });
    r.safeMode = { on: true, reason };
    return r;
  }

  function search(args) {
    return serial(async () => {
      try {
        const query = String(args?.query ?? '');
        const detail = args?.detail === 'full' || args?.detail === 'brief' ? args.detail : undefined;
        const a = ensureActive();
        if (!a.probed) await probe();
        let result;
        let reason = null;
        try {
          result = await a.runner.call({ type: 'search', query, options: { detail } }, a.recipe.deadlineMs);
        } catch (err) {
          reason = err.message;
          result = await safeMode(a, query, detail, reason);
        }
        status.lastSearch = { ok: !reason, at: Date.now(), safeMode: !!reason, reason };
        save();
        const notes = args?.k !== undefined ? ['k is ignored in version 5; use detail "brief" or "full".'] : [];
        return format(result, a.recipe, notes);
      } catch (e) {
        status.lastSearch = { ok: false, at: Date.now(), safeMode: false, reason: e.message };
        save();
        throw e;
      }
    });
  }

  async function autoUpdate() {
    if (busy) return;
    try {
      const a = active ?? ensureActive();
      await (await importFrom(a.appDir, 'cli', 'updater.mjs')).checkForUpdate({ home });
    } catch {}
  }

  async function handle(msg) {
    switch (msg.method) {
      case 'initialize':
        return { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ruvnet-brain', version: status.app ?? '5' } };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [TOOL] };
      case 'tools/call': {
        if (msg.params?.name !== TOOL.name) throw Object.assign(new Error(`unknown tool ${msg.params?.name}`), { code: -32602 });
        try {
          return { content: [{ type: 'text', text: await search(msg.params.arguments) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `RuvNet Brain DOWN · search failed: ${e.message} · fix: ruvnet-brain doctor` }], isError: true };
        }
      }
      default:
        if (msg.id === undefined) return undefined;
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  }

  const send = (m) => output.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    handle(msg).then(
      (result) => msg.id !== undefined && result !== undefined && send({ jsonrpc: '2.0', id: msg.id, result }),
      (e) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
    );
  });

  const timers = [
    setInterval(save, cfg.heartbeatMs),
    setInterval(() => serial(probe).catch(() => {}), cfg.probeIntervalMs),
    setInterval(autoUpdate, cfg.updateIntervalMs),
  ];
  for (const t of timers) t.unref();
  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    active?.runner.terminate();
    removeStatus(home, process.pid);
    process.exit(0);
  };
  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  save();
  serial(probe).catch(() => {});
}
