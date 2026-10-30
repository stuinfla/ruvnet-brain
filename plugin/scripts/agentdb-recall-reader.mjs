/** Bounded read-only projection of canonical Ruflo rows THROUGH THE RUFLO CLI — never direct SQLite
 * (owner ruling 2026-10-12: hooks call rUv's tools, they do not reimplement them). Run as an owned child
 * so a stalled CLI is retired at the recall deadline. Output contract unchanged: {ok, value}.
 */
import { execFile } from 'node:child_process';
import readline from 'node:readline';
import { resolveRuflo, rufloInvocationOrPlain } from './ruflo-bin.mjs';

/** Batch session (#429): ONE process answering line-based `list` / `get` requests by calling the installed Ruflo
 * package's own public `@claude-flow/cli/memory` export — the functions its `memory list` / `memory retrieve`
 * commands call. argv: --session <storePath> <moduleUrl>. Replies are single JSON lines on the real stdout. */
async function session(storePath, moduleUrl) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest); // module chatter must not corrupt the protocol
  const reply = (row) => write(JSON.stringify(row) + '\n');
  let mod;
  try { mod = await import(moduleUrl); } catch { mod = null; }
  if (!mod || typeof mod.listEntries !== 'function' || typeof mod.getEntry !== 'function' || typeof mod.resolveDbPath !== 'function') {
    reply({ ready: false }); process.exit(0);
  }
  const dbPath = mod.resolveDbPath(storePath);
  reply({ ready: true });
  const run = async ({ op, namespace, key, limit }) => {
    if (typeof namespace !== 'string') return { state: 'fallback' };
    if (op === 'list') {
      const r = await mod.listEntries({ namespace, limit, offset: 0, dbPath });
      if (r?.success === false) return { state: 'unavailable' };
      // Every entry must carry a string key. If Ruflo renames the field the list is UNREADABLE by this route, never
      // an empty namespace: fall back to the CLI route rather than report no memory (#429).
      return r?.success === true && Array.isArray(r.entries) && r.entries.every((e) => e && typeof e === 'object' && typeof e.key === 'string')
        ? { state: 'ok', rows: r.entries.map((e) => ({ key: e.key, createdAt: e.createdAt })) } : { state: 'fallback' };
    }
    if (op === 'get' && typeof key === 'string' && key) {
      const r = await mod.getEntry({ key, namespace, dbPath });
      if (r?.success === false || r?.success === true && r.found === false) return { state: 'unavailable' };
      return r?.success === true && typeof r.entry?.content === 'string' ? { state: 'ok', value: r.entry.content } : { state: 'fallback' };
    }
    return { state: 'fallback' };
  };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let request; try { request = JSON.parse(line); } catch { return; }
    run(request).catch(() => ({ state: 'unavailable' })).then((out) => reply({ id: request.id, ...out }));
  }).on('close', () => process.exit(0));
}

const call = (bin, args, deadline) => new Promise((resolve) => {
  const timeout = Math.max(1, deadline - Date.now());
  const inv = rufloInvocationOrPlain(bin, args, { env: process.env });
  execFile(inv.executable, inv.args, { timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false' } },
    (error, stdout) => resolve(error ? null : String(stdout || '')));
});

if (process.argv[2] === '--session') await session(process.argv[3], process.argv[4]);
else try {
  const [storePath, input] = process.argv.slice(2);
  const { requests, namespaces, deadline } = JSON.parse(input);
  if (!Number.isFinite(deadline) || Date.now() >= deadline
    || requests && (!Array.isArray(requests) || requests.length > 32
      || requests.some(row => typeof row?.namespace !== 'string' || typeof row?.key !== 'string' || !row.key))
    || namespaces && (!Array.isArray(namespaces) || namespaces.length > 8 || namespaces.some(value => typeof value !== 'string'))
    || Boolean(requests) === Boolean(namespaces)) throw new Error('invalid bounded read');
  const bin = resolveRuflo();
  if (!bin) throw new Error('global Ruflo unavailable');
  let value;
  if (requests) {
    value = await Promise.all(requests.map(async ({ namespace, key }) => {
      const out = await call(bin, ['memory', 'retrieve', '--key', key, '--namespace', namespace, '--value-only', '--path', storePath], deadline);
      return out === null ? null : out.trim();
    }));
  } else {
    const lists = await Promise.all(namespaces.map(async (namespace) => {
      const out = await call(bin, ['memory', 'list', '--namespace', namespace, '--limit', '100000', '--format', 'json', '--path', storePath], deadline);
      if (out === null) throw new Error('list failed');
      const at = out.indexOf('[');
      const rows = at < 0 ? [] : JSON.parse(out.slice(at));
      // A list whose entries lack a string key is a changed contract, not an empty namespace: fail the read.
      if (!Array.isArray(rows) || rows.some((row) => typeof row?.key !== 'string')) throw new Error('list shape changed');
      return [namespace, rows.map((row) => row.key)];
    }));
    value = Object.fromEntries(lists);
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, fatal: true }));
}
