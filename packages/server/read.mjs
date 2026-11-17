// read_ruvnet, inside the worker thread: the lines of one file the pack cites, rebuilt from the pack's
// own passages (the pack holds no other copy of a file, and nothing is read from disk by path).
// ref = "repo/path#L120-260" (the range is optional). The path check refuses a ref that is not a plain
// repo/path, and a private pack's file is read only from a project on that pack's list, exactly as search.
import path from 'node:path';
import { openPrivates } from './widen.mjs';

const REF = /^(.+?)(?:#L(\d+)(?:-L?(\d+))?)?$/;
const refuse = (why) => Object.assign(new Error(`refused: ${why}`), { refused: true });

/** Normalised absolute folder, for comparing projects (the engine's rule). */
function folder(p) {
  let s = path.resolve(String(p));
  if (s.length > 1 && s.endsWith(path.sep)) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** The path check: a plain repo/path, and a private pack only from one of its listed projects. */
function outside(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 1024) return 'ref must be "repo/path" or "repo/path#L10-80"';
  // A control character is refused and never echoed as it is, so a ref cannot add a line to the answer (review F18).
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(ref)) return `${JSON.stringify(ref).replace(/[\u2028\u2029]/g, '?')} is not a path inside the pack`;
  if (/[\0\\]/.test(ref) || /^([a-zA-Z]:|\/|~)/.test(ref)) return `${ref} is not a path inside the pack`;
  const segs = ref.split('#')[0].split('/');
  if (segs.length < 2 || segs.some((s) => !s || s === '.' || s === '..')) return `${ref} is not a path inside the pack`;
  return null;
}
function inScope(pack, project) {
  if (pack.access !== 'private') return true;
  if (!project) return false;
  const here = folder(project);
  return (pack.projects ?? []).map(folder).some((a) => here === a || here.startsWith(a.endsWith(path.sep) ? a : a + path.sep));
}

/** The file's text from its passages, line for line from its first cited line (gaps come back empty). */
function rebuild(rows) {
  if (rows[0].start_line == null) {
    const text = rows.map((r) => (r.header && !r.text.startsWith(r.header) ? `${r.header}\n${r.text}` : r.text)).join('\n\n');
    return { first: 1, lines: text.split('\n') };
  }
  let text = '';
  rows.forEach((r, k) => (text += (k === 0 ? '' : '\n'.repeat(Math.max(0, r.start_line - rows[k - 1].end_line))) + r.text));
  return { first: rows[0].start_line, lines: text.split('\n') };
}

export function read(engine, handle, privates, m) {
  const why = outside(m.ref);
  if (why) throw refuse(why);
  const [, ref0, a, b] = REF.exec(m.ref);
  // private:<name>/<repo>/<path> reads that private pack only (review F17); a plain ref reads the
  // installed pack first, then the private packs.
  const own = /^private:([^/]+)\/(.+)$/.exec(ref0);
  const ref = own ? own[2] : ref0;
  const cut = ref.indexOf('/');
  if (cut < 0) throw refuse(`${ref0} is not a path inside the pack`);
  const repo = ref.slice(0, cut);
  const file = ref.slice(cut + 1);
  const privs = m.privateDir ? openPrivates(engine, privates, m.privateDir) : [];
  const packs = own ? privs.filter((p) => p.name === own[1]).map((p) => p.h) : [handle, ...privs.map((p) => p.h)];
  for (const h of packs.filter((x) => inScope(x.pack, m.project))) {
    const rows = engine.read(h, repo, file);
    if (!rows.length) continue;
    const { first, lines } = rebuild(rows);
    const last = first + lines.length - 1;
    const start = a ? Number(a) : first;
    const end = Math.min(b ? Number(b) : last, last);
    if (start > last || start < 1 || end < start) throw refuse(`${repo}/${file} has lines ${first}-${last}; asked for ${a ?? first}-${b ?? last}`);
    const src = h.pack.sources.find((s) => s.repo === repo);
    return {
      repo: own ? `private:${own[1]}/${repo}` : repo,
      path: file,
      first,
      last,
      start: Math.max(start, first),
      end,
      text: lines.slice(Math.max(start, first) - first, end - first + 1).join('\n'),
      commit: rows[0].commit_id ?? src?.commit ?? 'unknown',
      date: rows[0].date ?? src?.date ?? null,
      standing: rows[0].standing ?? 'unknown',
      flag: rows.some((r) => r.flag === 'hostile') ? 'hostile' : null,
      generation: h.pack.generation,
    };
  }
  throw refuse(`${ref0} is not a file in this pack`);
}
