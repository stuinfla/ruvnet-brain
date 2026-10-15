/** Bounded read-only projection of canonical Ruflo rows THROUGH THE RUFLO CLI — never direct SQLite
 * (owner ruling 2026-10-12: hooks call rUv's tools, they do not reimplement them). Run as an owned child
 * so a stalled CLI is retired at the recall deadline. Output contract unchanged: {ok, value}.
 */
import { execFile } from 'node:child_process';
import { resolveRuflo, rufloInvocationOrPlain } from './ruflo-bin.mjs';

const call = (bin, args, deadline) => new Promise((resolve) => {
  const timeout = Math.max(1, deadline - Date.now());
  const inv = rufloInvocationOrPlain(bin, args, { env: process.env });
  execFile(inv.executable, inv.args, { timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } },
    (error, stdout) => resolve(error ? null : String(stdout || '')));
});

try {
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
      return [namespace, at < 0 ? [] : JSON.parse(out.slice(at)).map((row) => row.key).filter((key) => typeof key === 'string')];
    }));
    value = Object.fromEntries(lists);
  }
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, fatal: true }));
}
