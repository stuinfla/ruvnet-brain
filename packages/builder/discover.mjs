// Reads one source folder (a checkout at a recorded commit, with <sources.sourceFile> = { repo,
// commit, date }) into documents, applying the recipe's skip rules (ported from the measured run's
// kb/rvf-source-adapters.mjs). Folders named `v2` are walked: no rule names them. Every exclusion is
// recorded with a reason, never silent. Any read error makes the whole source unreadable (it is then
// carried at its last good state by build.mjs), so a half-read source never ships.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { kindOf, languageOf } from './units.mjs';

export class Unreadable extends Error {}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function skipDir(name, parent, s) {
  if (s.excludeDirs.has(name)) return `skip-dir:${name}`;
  if (name === 'build' && s.buildManifests.some((m) => fs.existsSync(path.join(parent, m)))) return 'skip-dir:build-output';
  return null;
}

function skipFile(rel, raw, size, s) {
  const base = path.posix.basename(rel);
  if (s.skipNames.has(base)) return 'lockfile';
  if (s.skipPaths.some((re) => re.test(rel))) return 'skip-path';
  if (size > s.maxFileBytes) return 'too-large';
  if (raw === null) return null;
  const head = raw.slice(0, 65536);
  if (head.includes('\u0000')) return 'binary';
  const bad = (head.match(/[\u0001-\u0008\u000e-\u001f�]/g) || []).length;
  if (head.length && bad / head.length > 0.01) return 'binary';
  if (s.generated.test(head.split('\n').slice(0, 10).join('\n'))) return 'generated';
  const lines = head.split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > 5000 && head.length / lines.length > 300 && !rel.endsWith('.json')) return 'minified';
  return null;
}

/** Returns { meta, docs: [{ rel, type, kind, lang, text }], skipped, truncated, contentHash }. */
export function readSource(dir, s) {
  let metaText;
  try {
    metaText = fs.readFileSync(path.join(dir, s.sourceFile), 'utf8');
  } catch (e) {
    throw new Unreadable(`${s.sourceFile} cannot be read (${e.code || e.message})`);
  }
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    throw new Unreadable(`${s.sourceFile} is not valid JSON`);
  }
  for (const k of ['repo', 'commit', 'date']) if (typeof meta[k] !== 'string' || !meta[k]) throw new Unreadable(`${s.sourceFile} has no ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Unreadable(`${s.sourceFile} date ${meta.date} is not YYYY-MM-DD`);
  const skipped = [];
  const truncated = [];
  const docs = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort(byName);
    } catch (e) {
      throw new Unreadable(`folder ${rel || '.'} cannot be read (${e.code || e.message})`);
    }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        const why = skipDir(ent.name, path.join(dir, rel), s);
        if (why) {
          if (ent.name !== '.git') skipped.push({ path: `${r}/`, reason: why });
        } else walk(r);
        continue;
      }
      if (!ent.isFile() || r === s.sourceFile) continue;
      const ext = path.posix.extname(r).toLowerCase();
      const type = s.typeOfExt.get(ext);
      if (!type || !s.include.has(ext)) continue;
      let size;
      let raw = null;
      try {
        size = fs.statSync(path.join(dir, r)).size;
        if (!skipFile(r, null, size, s)) raw = fs.readFileSync(path.join(dir, r), 'utf8');
      } catch (e) {
        throw new Unreadable(`file ${r} cannot be read (${e.code || e.message})`);
      }
      const why = skipFile(r, raw, size, s);
      if (why) {
        skipped.push({ path: r, reason: why });
        continue;
      }
      let text = raw.replace(/\r\n?/g, '\n');
      const kind = kindOf(r, type, text);
      if (kind === 'config' && text.length > s.configMaxChars) {
        const cut = text.lastIndexOf('\n', s.configMaxChars);
        truncated.push({ path: r, keptChars: cut > 0 ? cut : s.configMaxChars, totalChars: text.length });
        text = text.slice(0, cut > 0 ? cut : s.configMaxChars);
      }
      if (!text.trim()) continue;
      docs.push({ rel: r, type, kind, lang: languageOf(r, type), text });
    }
  };
  walk('');
  docs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const contentHash = sha(JSON.stringify({ meta, docs: docs.map((d) => [d.rel, sha(d.text)]), skipped, truncated }));
  return { meta: { repo: meta.repo, commit: meta.commit, date: meta.date }, docs, skipped, truncated, contentHash };
}
