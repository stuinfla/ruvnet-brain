// Where a release comes from: a folder, or a web address serving the same layout
// (<base>/release.json, <base>/app/<path>, <base>/pack/<path>). Every file is copied by streaming
// into its staging place while it is hashed, so no file is ever read whole (no 2 GiB limit) and
// the bytes checked are the bytes kept. A download cut off part-way resumes from the byte it reached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Refused extends Error {}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const RELEASE_MAX_BYTES = 16 << 20;
const ATTEMPTS = 6;

export const isUrl = (s) => /^https?:\/\//i.test(String(s));

/** `rel` (posix, from release.json) resolved inside dir; refuses a path that escapes it. */
export function within(dir, rel) {
  const p = path.resolve(dir, ...rel.split('/'));
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Refused(`${rel} points outside the release`);
  return p;
}

function folderSource(dir) {
  return {
    where: dir,
    kind: 'folder',
    async releaseText() {
      try {
        return await fs.promises.readFile(path.join(dir, 'release.json'), 'utf8');
      } catch {
        throw new Refused(`no readable release.json in ${dir}`);
      }
    },
    async *bytes(part, rel, start) {
      const file = within(path.join(dir, part), rel);
      if (!fs.existsSync(file)) return;
      yield* fs.createReadStream(file, { start, highWaterMark: 1 << 20 });
    },
  };
}

function webSource(address) {
  const base = new URL(address.endsWith('/') ? address : `${address}/`);
  if (base.protocol !== 'https:' && !LOOPBACK.has(base.hostname)) throw new Refused(`refusing ${base.origin}: releases are downloaded over https only`);
  const get = (rel, headers = {}) => fetch(new URL(rel, base), { headers, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  return {
    where: base.href,
    kind: 'web',
    async releaseText() {
      let res;
      try {
        res = await get('release.json');
      } catch (e) {
        throw new Refused(`could not reach ${base.href}release.json (${e.cause?.code ?? e.message})`);
      }
      if (!res.ok) throw new Refused(`${base.href}release.json answered HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > RELEASE_MAX_BYTES) throw new Refused('release.json is larger than any real release manifest');
      return text;
    },
    async *bytes(part, rel, start) {
      const res = await get(`${part}/${rel.split('/').map(encodeURIComponent).join('/')}`, start > 0 ? { range: `bytes=${start}-` } : {});
      if (res.status === 404) return;
      if (start > 0 && res.status === 200) throw Object.assign(new Error('the server ignored the resume request'), { restart: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (start > 0 && !String(res.headers.get('content-range') ?? '').startsWith(`bytes ${start}-`)) throw Object.assign(new Error('the server resumed from the wrong byte'), { restart: true });
      for await (const chunk of res.body) yield chunk;
    },
  };
}

export const openSource = (from) => (isUrl(from) ? webSource(from) : folderSource(path.resolve(from)));

async function hashPrefix(file, hash) {
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk);
}

/**
 * Streams one listed file from the source into `dest`, hashing as it writes. A partial `dest` left by
 * an earlier attempt or an earlier run is kept and continued. Throws Refused when the bytes do not
 * match the signed size and hash (the partial file is removed), or a plain Error when the source
 * could not deliver them after several attempts (the partial file is kept, to resume later).
 */
export async function copyVerified(src, part, f, dest, what, { onBytes } = {}) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  let have = 0;
  try {
    have = (await fs.promises.stat(dest)).size;
  } catch {}
  if (have > f.size) {
    await fs.promises.rm(dest, { force: true });
    have = 0;
  }
  let hash = crypto.createHash('sha256');
  if (have > 0) await hashPrefix(dest, hash);
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const fh = await fs.promises.open(dest, have > 0 ? 'a' : 'w');
    let got = 0;
    try {
      for await (const chunk of src.bytes(part, f.path, have)) {
        if (have + chunk.length > f.size) throw new Refused(`${what} file ${f.path} does not match the signed release (larger than signed)`);
        await fh.write(chunk);
        hash.update(chunk);
        have += chunk.length;
        got += chunk.length;
        onBytes?.(chunk.length);
      }
      lastError = null;
      break;
    } catch (e) {
      if (e instanceof Refused) throw await drop(dest, e);
      lastError = e;
      if (e.restart) {
        await fh.truncate(0);
        have = 0;
        hash = crypto.createHash('sha256');
      }
      if (!got && !e.restart && attempt > 2) await new Promise((r) => setTimeout(r, 250 * attempt));
    } finally {
      await fh.close();
    }
  }
  if (lastError && have < f.size) throw new Error(`${what} file ${f.path} could not be fetched from ${src.where} (${lastError.cause?.code ?? lastError.message}); run the same command again to resume`);
  if (have !== f.size || hash.digest('hex') !== f.sha256) {
    throw await drop(dest, new Refused(`${what} file ${f.path} does not match the signed release (missing, changed or damaged)`));
  }
}

async function drop(file, err) {
  await fs.promises.rm(file, { force: true });
  return err;
}

/** Streams every listed file of an existing folder through the hash; true when all match. */
export async function matches(dir, files) {
  for (const f of files) {
    const p = within(dir, f.path);
    try {
      if ((await fs.promises.stat(p)).size !== f.size) return false;
      const h = crypto.createHash('sha256');
      await hashPrefix(p, h);
      if (h.digest('hex') !== f.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}
