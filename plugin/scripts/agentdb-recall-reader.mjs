/** Bounded read-only projection of canonical Ruflo rows; never opens a second store.
 * Run as an owned child so SQLite/filesystem stalls can be retired at the recall deadline.
 * Unsupported schema stands down to global Ruflo; malformed/duplicate rows fail closed.
 */
import { withProgressionReader } from './project-progression-reader.mjs';

try {
  const [storePath, input] = process.argv.slice(2);
  const { requests, namespaces, deadline } = JSON.parse(input);
  if (!Number.isFinite(deadline) || Date.now() >= deadline
    || requests && (!Array.isArray(requests) || requests.length > 32
      || requests.some(row => typeof row?.namespace !== 'string' || typeof row?.key !== 'string' || !row.key))
    || namespaces && (!Array.isArray(namespaces) || namespaces.length > 8 || namespaces.some(value => typeof value !== 'string'))
    || Boolean(requests) === Boolean(namespaces)) throw new Error('invalid bounded read');
  const result = withProgressionReader(storePath, reader => requests
    ? requests.map(({ namespace, key }) => reader.readContent(namespace, key))
    : Object.fromEntries(namespaces.map(namespace => [namespace, reader.listKeys(namespace, { maxEntries: 100000 })])),
  { deadlineAt: deadline });
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, fatal: true }));
}
