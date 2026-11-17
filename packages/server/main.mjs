// The MCP server (architecture 2.2): one stable process per session, newline-delimited JSON-RPC on
// stdio, tools `search_ruvnet` and `read_ruvnet`, and the five layered tools (map_ruvnet, facts_ruvnet,
// find_ruvnet, context_ruvnet, source_ruvnet; layered-tools.mjs). Calls run in a small pool of worker threads behind
// one queue (runner.mjs), each under the recipe's deadline; when a worker dies, runs out of time or
// cannot be reached in time, the main thread answers from the keyword lane ("safe mode").
// Before every call the pointer file is re-read, so a new app or pack is picked up without a restart;
// calls already running finish on the old workers.
// The project a question comes from is the client's first root when it offers roots, else the folder
// the host started the server in. Private packs are searched only from a project on their list.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paths, readConfig, readJson, readPointer } from '../contract/home.mjs';
import { problems } from '../contract/validate.mjs';
import { removeStatus, writeStatus } from '../health/status.mjs';
import { pageCheck } from '../health/page.mjs';
import { createRunner } from './runner.mjs';
import { createHelpers } from './helper.mjs';
import { format, formatRead } from './format.mjs';
import { READ, SEARCH, detailOf, extraTerms } from './tools.mjs';
import { LAYERED_NAMES, checkArgs, layeredList } from './layered-tools.mjs';
import { real } from './widen.mjs';
import { toolResult } from './wire.mjs';

const MAX_LINE = 1_000_000;
/** A request value as an error may echo it: at most 200 characters (review F22). */
const clip = (v) => (String(v).length > 200 ? `${String(v).slice(0, 200)}… (${String(v).length} characters)` : String(v));
const importFrom = (dir, ...rel) => import(pathToFileURL(path.join(dir, ...rel)).href);

/** A helper lane's item is used only if it is a result item this server can cite. */
const usable = (name) => (it) => !problems('result', { schema: 'ruvnet-brain/result', version: 1, generation: '-', knowledgeDate: '-', recipeId: '-', detail: 'brief', lanes: [], safeMode: { on: false }, sections: [{ name, items: [it], empty: null }] }).length;

export async function run({ home, input = process.stdin, output = process.stdout, cwd = process.cwd() }) {
  const cfg = readConfig(home);
  const now = Date.now();
  const status = { schema: 'ruvnet-brain/status', version: 1, pid: process.pid, startedAt: now, heartbeatAt: now, app: null, pack: null, knowledgeDate: null, lanes: [], probe: null, lastSearch: null, load: null };
  let active = null;
  let project = real(process.env.CLAUDE_PROJECT_DIR || cwd);
  const save = () => {
    status.heartbeatAt = Date.now();
    status.load = active ? { ...active.runner.stats(), rssBytes: process.memoryUsage().rss } : null;
    try {
      writeStatus(home, status);
    } catch {}
  };

  function ensureActive() {
    const ptr = readPointer(home);
    if (!ptr) throw new Error('RuvNet Brain 5 is not installed (no current.json); run: ruvnet-brain install');
    if (!active || active.app !== ptr.app || active.pack !== ptr.pack) {
      active?.runner.retire();
      active?.helpers.stop();
      if (active?.safe) active.safeEngine.close(active.safe);
      const appDir = path.join(paths(home).app, ptr.app);
      const packDir = path.join(paths(home).packs, ptr.pack);
      const pack = readJson(path.join(packDir, 'PACK.json'));
      const recipe = readJson(path.join(packDir, pack.files.find((f) => f.role === 'recipe').path));
      active = { app: ptr.app, pack: ptr.pack, appDir, packDir, recipe, runner: createRunner(appDir, packDir), helpers: createHelpers(appDir, packDir, recipe), probed: false, probing: null };
      Object.assign(status, { app: ptr.app, pack: ptr.pack, knowledgeDate: pack.knowledgeDate, probe: null, lastSearch: null });
    }
    return active;
  }

  /** Engine lanes with the helper lanes' own state in place of the engine's view of them. */
  const lanesOf = (a, engineLanes) => [...(engineLanes ?? []).filter((l) => !a.helpers.lanes().some((x) => x.name === l.name)), ...a.helpers.lanes()];

  async function doProbe(a) {
    const at = Date.now();
    let t;
    try {
      t = await a.runner.call({ type: 'selfTest' }, a.recipe.deadlineMs, { fresh: true });
      if (a.helpers.any) await a.helpers.restart();
      a.probed = true;
    } catch (e) {
      t = { ok: false, error: e.message, results: [] };
    }
    if (a !== active) return;
    const failingSince = t.ok ? null : status.probe && !status.probe.ok ? status.probe.failingSince : at;
    status.probe = { ok: t.ok, at, failingSince, error: t.error ?? (t.ok ? null : 'a probe did not find its expected file'), results: t.results };
    if (t.lanes) status.lanes = lanesOf(a, t.lanes);
    save();
  }
  /** One probe at a time per active version, however many calls ask for it. */
  function probe() {
    let a;
    try {
      a = ensureActive();
    } catch (e) {
      status.probe = { ok: false, at: Date.now(), failingSince: status.probe?.failingSince ?? Date.now(), error: e.message, results: [] };
      return save();
    }
    a.probing ??= doProbe(a).finally(() => (a.probing = null));
    return a.probing;
  }

  async function safeMode(a, query, detail, reason) {
    if (!a.safe) {
      a.safeEngine = await importFrom(a.appDir, 'engine', 'index.mjs');
      a.safe = a.safeEngine.open(a.packDir);
    }
    const r = a.safeEngine.search(a.safe, query, { detail, lanes: ['lexical'], project });
    r.safeMode = { on: true, reason };
    // A lane safe mode left out was not run; it is not broken (that reason stays as the engine gave it).
    const helperLanes = new Set(a.helpers.lanes().map((l) => l.name));
    for (const s of r.sections) {
      const lane = a.recipe.sections.find((x) => x.name === s.name)?.lane;
      const skipped = s.empty?.reason?.startsWith(`lane ${lane} is not available`) && r.lanes.find((l) => l.name === lane)?.available;
      if (lane !== 'lexical' && (skipped || helperLanes.has(lane))) s.empty = { reason: `lane ${lane} was not run: safe mode searches the keyword lane only` };
    }
    r.lanes = lanesOf(a, r.lanes);
    return r;
  }

  async function fillHelpers(a, result, query, detail, msLeft) {
    const got = await a.helpers.search(query, detail, msLeft);
    for (const [name, v] of got) {
      const sec = result.sections.find((s) => s.name === name);
      if (!sec) continue;
      sec.items = (v.items ?? []).filter(usable(name));
      sec.empty = sec.items.length ? null : { reason: v.reason ?? `lane ${name.toLowerCase()} found nothing` };
    }
    result.lanes = lanesOf(a, result.lanes);
  }

  async function search(args) {
    try {
      const query = String(args?.query ?? '');
      if (typeof args?.query !== 'string' || !query.trim()) return { text: 'query is required: pass the question in the user\'s own words.', isError: true };
      const detail = detailOf(args);
      const extra = extraTerms(args);
      const t0 = Date.now();
      const a = ensureActive();
      if (!a.probed) await probe();
      let result;
      let reason = null;
      try {
        result = await a.runner.call({ type: 'search', query, options: { detail, project }, extraTerms: extra.terms, privateDir: paths(home).private }, a.recipe.deadlineMs);
        if (a.helpers.any) await fillHelpers(a, result, query, detail ?? a.recipe.result.defaultDetail, a.recipe.deadlineMs - (Date.now() - t0));
      } catch (err) {
        reason = err.message;
        result = await safeMode(a, query, detail, reason);
      }
      status.lastSearch = { ok: !reason, at: Date.now(), safeMode: !!reason, reason };
      save();
      const notes = args?.k !== undefined ? ['k is ignored in version 5; use detail "brief" or "full".'] : [];
      if (extra.note) notes.push(extra.note);
      if (extra.terms.length && a.recipe.query?.extraTerms !== 'append') notes.push(`extra_terms received and not searched: recipe ${a.recipe.id} searches the question as given.`);
      else if (extra.terms.length && reason) notes.push('extra_terms were not searched: safe mode searches the question as given.');
      return { text: format(result, a.recipe, notes) };
    } catch (e) {
      status.lastSearch = { ok: false, at: Date.now(), safeMode: false, reason: e.message };
      save();
      throw e;
    }
  }

  async function read(args) {
    const detail = detailOf(args) ?? 'brief';
    const a = ensureActive();
    try {
      const r = await a.runner.call({ type: 'read', ref: args?.ref, project, privateDir: paths(home).private }, a.recipe.deadlineMs);
      return { text: formatRead(r, a.recipe, detail) };
    } catch (e) {
      return { text: `RuvNet Brain · read_ruvnet ${/^refused: /.test(e.message) ? e.message : `failed: ${e.message}`}`, isError: true };
    }
  }

  /** A layered tool: arguments checked here, the store read in a worker under the recipe's deadline
   *  (never on this thread, never in safe mode: a layered answer is the store's or an error). */
  async function layered(def, args) {
    const c = checkArgs(def.tool, args);
    if (c.error) return { text: `RuvNet Brain · ${def.name} refused: ${c.error}`, isError: true };
    const a = ensureActive();
    try {
      return { text: await a.runner.call({ type: 'layered', tool: def.tool, args: c.args }, a.recipe.deadlineMs) };
    } catch (e) {
      return { text: `RuvNet Brain · ${def.name} ${/^refused: /.test(e.message) ? e.message : `failed: ${e.message}`}`, isError: true };
    }
  }

  async function autoUpdate() {
    if (active?.runner.busy()) return;
    try {
      const a = active ?? ensureActive();
      await (await importFrom(a.appDir, 'cli', 'updater.mjs')).checkForUpdate({ home });
    } catch {}
  }

  const send = (m) => output.write(JSON.stringify(m) + '\n');
  let clientRoots = false;
  let rootsSeq = 0;
  // Fail closed (review F08): while a roots request is pending, and after an answer with no file: root,
  // there is no project, so no private pack is searched. Only the answer to the latest request counts.
  const askRoots = () => clientRoots && ((project = null), send({ jsonrpc: '2.0', id: `roots-${++rootsSeq}`, method: 'roots/list' }));
  function onRoots(m) {
    if (m.id !== `roots-${rootsSeq}`) return;
    const uri = m.result?.roots?.find((r) => String(r?.uri).startsWith('file:'))?.uri;
    try {
      project = uri ? real(fileURLToPath(uri)) : null;
    } catch {
      project = null;
    }
  }

  async function handle(msg) {
    switch (msg.method) {
      case 'initialize':
        clientRoots = !!msg.params?.capabilities?.roots;
        if (clientRoots) project = null;
        return { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ruvnet-brain', version: status.app ?? '5' } };
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
        askRoots();
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        // The same seven tools whatever pack is active, so the list never changes under a hot swap; a
        // pack without a layered store answers the layered tools with one sentence saying so.
        return { tools: [SEARCH, READ, ...layeredList()] };
      case 'tools/call': {
        const name = msg.params?.name;
        if (name !== SEARCH.name && name !== READ.name && !LAYERED_NAMES.has(name)) throw Object.assign(new Error(`unknown tool ${clip(name)}`), { code: -32602 });
        // Every result leaves through toolResult (wire.mjs): one text block, no structured copy, and
        // everything on the wire held to the delivery ceiling.
        try {
          const args = msg.params.arguments;
          const r = name === SEARCH.name ? await search(args) : name === READ.name ? await read(args) : await layered(LAYERED_NAMES.get(name), args);
          return toolResult(r.text, r.isError, active?.recipe);
        } catch (e) {
          return toolResult(`RuvNet Brain DOWN · search failed: ${e.message} · fix: ruvnet-brain doctor`, true, active?.recipe);
        }
      }
      default:
        if (msg.id === undefined) return undefined;
        throw Object.assign(new Error(`method not found: ${clip(msg.method)}`), { code: -32601 });
    }
  }

  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_LINE) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `request over ${MAX_LINE} characters` } });
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    if (msg.method === undefined && String(msg.id).startsWith('roots-')) return onRoots(msg);
    handle(msg).then(
      (result) => msg.id !== undefined && result !== undefined && send({ jsonrpc: '2.0', id: msg.id, result }),
      (e) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: toolResult(e.message, true, active?.recipe).content[0].text } }),
    );
  });

  const timers = [
    // The owner page (opt-in, state/config.json pageTopic) is decided after each heartbeat; it never
    // throws into the server and never blocks a search.
    setInterval(() => {
      save();
      pageCheck({ home }).catch(() => {});
    }, cfg.heartbeatMs),
    setInterval(() => probe(), cfg.probeIntervalMs),
    setInterval(autoUpdate, cfg.updateIntervalMs),
  ];
  for (const t of timers) t.unref();
  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    active?.runner.terminate();
    active?.helpers.stop();
    removeStatus(home, process.pid);
    process.exit(0);
  };
  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  save();
  probe();
}
