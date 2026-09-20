import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableChunkId } from './incremental-refresh.mjs';

export const FORGE_CHUNKER_VERSION = 'forge-corpus-v1';
export const FORGE_BUILD_FINGERPRINT = [
  FORGE_CHUNKER_VERSION,
  'Xenova/bge-base-en-v1.5@4d6cd88e18e51a5e020c2c305726d76ada9c03cf:768:cls',
].join('|');
export const MAX_CHUNK_CHARS = 4000;
export const CHUNK_OVERLAP_CHARS = 400;

const BASE_SKIP_DIRS = [
  'node_modules', 'target', '.git', 'dist', 'build', '.next', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.vite', 'vendor', 'v2',
];
const SKIP_NAME_RE = /\.(min\.js|min\.css|lock)$/;
const PLATFORM_STUB_RE = /\/npm\/[^/]+\/package\.json$/;
const VENDORED_RE = /(^|\/)(stub|pkg|\.vite|dist)(\/|$)/;
const SRC_EXT = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.c', '.cpp', '.h', '.hpp', '.java', '.rb', '.swift', '.kt']);
const CONFIG_EXT = new Set(['.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf']);
const CONFIG_MAX = 12000;

export function titleOf(text, fallback) {
  const match = text.match(/^#\s+(.+)$/m);
  return (match ? match[1] : fallback).slice(0, 200).trim();
}

export function docBlock(text, n = 30) {
  const lines = text.split('\n').slice(0, n);
  const rust = lines
    .filter((line) => /^\s*\/\/!/.test(line))
    .map((line) => line.replace(/^\s*\/\/!\s?/, ''));
  if (rust.length) return rust.join('\n').trim();
  const jsdoc = lines
    .filter((line) => /^\s*(\*|\/\*\*|\/\/|#)/.test(line))
    .map((line) => line.replace(/^\s*(\*|\/\*\*|\/\/|#)\s?/, ''));
  return jsdoc.join('\n').trim();
}

export function htmlText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function chunkText(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + MAX_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      if (para > i + MAX_CHUNK_CHARS / 2) end = para;
    }
    out.push(text.slice(i, end));
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP_CHARS;
  }
  return out;
}

export function buildCorpus({
  repo,
  name,
  fullPrefixes = [],
  keepNames = [],
  chunkerVersion = FORGE_CHUNKER_VERSION,
}) {
  // Proprietary ruOS coverage is an editorial capability summary, never repository
  // contents. Apply before traversal so --full/--keep cannot expose source or docs.
  const root = String(name).toLowerCase() === 'cognitum-ruos'
    ? fileURLToPath(new URL('./capability-summaries/cognitum-ruos/', import.meta.url))
    : path.resolve(repo);
  const skipDirs = new Set(BASE_SKIP_DIRS);
  for (const kept of keepNames) skipDirs.delete(kept);
  const excluded = { dirs: new Set(), files: 0, reasons: {} };

  function* walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          excluded.dirs.add(entry.name);
          continue;
        }
        yield* walk(absolute);
      } else if (entry.isFile()) {
        yield absolute;
      }
    }
  }

  // Corpus paths are durable identifiers shared across macOS, Linux, and Windows. Persisting the
  // host separator makes the same file hash to a different chunk ID on Windows and also breaks the
  // slash-based skip/full-prefix rules below. Canonicalize at the filesystem boundary once.
  const rel = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  const read = (absolute) => fs.readFileSync(absolute, 'utf8');
  const tryRead = (absolute) => {
    try {
      return read(absolute);
    } catch {
      return null;
    }
  };
  const firstLines = (text, n) => text.split('\n').slice(0, n).join('\n');
  const allFiles = [...walk(root)];
  const census = {};

  const categoryFor = (absolute) => {
    const relative = rel(absolute);
    const base = path.basename(absolute);
    const ext = path.extname(absolute).toLowerCase();
    if (SKIP_NAME_RE.test(base)) return null;
    if (base === 'Cargo.toml') return 'manifest';
    if (base === 'package.json') {
      if (PLATFORM_STUB_RE.test(relative) || VENDORED_RE.test(relative)) return null;
      return 'manifest';
    }
    if (base === 'SKILL.md') return 'skill';
    if (ext === '.md') {
      if (/adr/i.test(relative)) return 'adr';
      if (/ddd|domain/i.test(relative)) return 'ddd';
      if (/research/i.test(relative)) return 'research';
      if (/tutorial|guide/i.test(relative)) return 'tutorial';
      return 'doc';
    }
    if (ext === '.txt' || ext === '.rst') return 'doc';
    if (ext === '.html') return 'ui';
    if (SRC_EXT.has(ext)) return 'source';
    if (CONFIG_EXT.has(ext)) return 'config';
    return 'other';
  };

  for (const file of allFiles) {
    const category = categoryFor(file);
    if (category === null) {
      excluded.files++;
      continue;
    }
    census[category] = (census[category] || 0) + 1;
  }

  const docsFiles = [];
  const counts = {};
  const ingested = new Set();
  const add = (kind, relative, title, text, absolute) => {
    counts[kind] = (counts[kind] || 0) + 1;
    docsFiles.push({ path: relative, kind, title, text });
    if (absolute) ingested.add(absolute);
  };
  const isFull = (absolute) => fullPrefixes.some((prefix) => rel(absolute).startsWith(prefix));

  for (const file of allFiles) {
    if (ingested.has(file)) continue;
    const ext = path.extname(file).toLowerCase();
    if (!['.md', '.txt', '.rst'].includes(ext)) continue;
    const relative = rel(file);
    const text = read(file);
    let kind = 'doc';
    if (/adr/i.test(relative)) kind = 'adr';
    else if (/ddd|domain/i.test(relative)) kind = 'ddd';
    else if (/research/i.test(relative)) kind = 'research';
    else if (/tutorial|guide/i.test(relative)) kind = 'tutorial';
    else if (path.basename(file) === 'SKILL.md') kind = 'skill';
    add(kind, relative, titleOf(text, path.basename(file)), text, file);
  }

  for (const file of allFiles) {
    if (ingested.has(file)) continue;
    const base = path.basename(file);
    const relative = rel(file);
    if (base === 'Cargo.toml') {
      const manifest = read(file);
      const pkg = manifest.match(/^\[package\]([\s\S]*?)(?=^\[|\s*$(?![\s\S]))/m);
      const section = pkg ? pkg[1] : '';
      const get = (key) => {
        const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
        return match ? match[1] : '';
      };
      const packageName = get('name') || `${path.basename(path.dirname(file))} (workspace manifest)`;
      const members = (manifest.match(/members\s*=\s*\[([\s\S]*?)\]/m) || [, ''])[1]
        .split(/[\s,]+/).map((value) => value.replace(/["']/g, '')).filter(Boolean).join(', ');
      let text = `Rust crate / manifest: ${packageName}\nPath: ${relative}\n`;
      if (get('description')) text += `Description: ${get('description')}\n`;
      const keywords = (section.match(/^keywords\s*=\s*\[([^\]]*)\]/m) || [, ''])[1].replace(/"/g, '');
      if (keywords) text += `Keywords: ${keywords}\n`;
      if (members) text += `Workspace members: ${members}\n`;
      text += `\n${manifest}`;
      add('manifest', relative, packageName, text, file);
    } else if (base === 'package.json') {
      if (PLATFORM_STUB_RE.test(relative) || VENDORED_RE.test(relative)) {
        excluded.files++;
        continue;
      }
      try {
        const manifest = JSON.parse(read(file));
        const scripts = manifest.scripts
          ? Object.entries(manifest.scripts).map(([key, value]) => `  ${key}: ${value}`).join('\n')
          : '';
        const bin = manifest.bin
          ? (typeof manifest.bin === 'string' ? manifest.bin : Object.keys(manifest.bin).join(', '))
          : '';
        const text = `npm package: ${manifest.name || relative}\nVersion: ${manifest.version || ''}\nPath: ${relative}\n`
          + `Description: ${manifest.description || ''}\n`
          + (bin ? `Bin: ${bin}\n` : '')
          + (manifest.type ? `Module type: ${manifest.type}\n` : '')
          + (scripts ? `Scripts:\n${scripts}\n` : '')
          + (manifest.dependencies ? `Dependencies: ${Object.keys(manifest.dependencies).join(', ')}\n` : '')
          + (manifest.devDependencies ? `DevDependencies: ${Object.keys(manifest.devDependencies).join(', ')}\n` : '')
          + `Keywords: ${(manifest.keywords || []).join(', ')}`;
        add('manifest', relative, manifest.name || relative, text, file);
      } catch {
        add('manifest', relative, relative, `npm package manifest (unparseable JSON) at ${relative}`, file);
      }
    }
  }

  const cargoDirs = new Set(
    allFiles.filter((file) => path.basename(file) === 'Cargo.toml').map((file) => path.dirname(file)),
  );
  const leadFiles = new Set();
  for (const cargoDir of cargoDirs) {
    const lead = ['src/lib.rs', 'src/main.rs']
      .map((file) => path.join(cargoDir, file))
      .find((file) => fs.existsSync(file));
    if (lead) leadFiles.add(lead);
  }

  const intentionallySkipped = [];
  for (const file of allFiles) {
    if (ingested.has(file)) continue;
    const ext = path.extname(file).toLowerCase();
    if (!SRC_EXT.has(ext)) continue;
    const relative = rel(file);
    const text = read(file);
    if (isFull(file)) {
      add('source', relative, path.basename(file), `Source ${relative} (full body):\n${text}`, file);
    } else if (leadFiles.has(file)) {
      const doc = docBlock(text, 200);
      add(
        'source',
        relative,
        `${path.basename(path.dirname(path.dirname(file)))} ${path.basename(file)}`,
        `Crate lead ${relative} — leading doc + first 100 lines:\n`
          + (doc ? `/* doc */\n${doc}\n\n` : '') + firstLines(text, 100),
        file,
      );
    } else {
      const doc = docBlock(firstLines(text, 30));
      if (!doc) {
        intentionallySkipped.push(relative);
        continue;
      }
      add('source', relative, path.basename(file), `Module ${relative} — doc comment:\n${doc}`, file);
    }
  }

  for (const cargoDir of cargoDirs) {
    const srcDir = path.join(cargoDir, 'src');
    if (!fs.existsSync(srcDir)) continue;
    const modules = [...walk(srcDir)]
      .filter((file) => SRC_EXT.has(path.extname(file)))
      .map((file) => path.relative(srcDir, file))
      .sort();
    if (!modules.length) continue;
    const relativeDir = rel(cargoDir) || '.';
    add(
      'source',
      `${relativeDir}/src`,
      `${path.basename(cargoDir)} modules`,
      `Crate ${path.basename(cargoDir)} (${relativeDir}) modules: ${modules.join(', ')}`,
    );
  }

  for (const file of allFiles) {
    if (ingested.has(file) || path.extname(file).toLowerCase() !== '.html') continue;
    const text = htmlText(read(file));
    if (text) add('ui', rel(file), path.basename(file), `UI page ${rel(file)} full text content:\n${text}`, file);
  }

  for (const file of allFiles) {
    if (ingested.has(file)) continue;
    const ext = path.extname(file).toLowerCase();
    if (!CONFIG_EXT.has(ext)) continue;
    const base = path.basename(file);
    const relative = rel(file);
    if (SKIP_NAME_RE.test(base)) continue;
    if (PLATFORM_STUB_RE.test(relative) || VENDORED_RE.test(relative)) continue;
    const raw = tryRead(file);
    if (raw == null) continue;
    const text = raw.length > CONFIG_MAX
      ? raw.slice(0, CONFIG_MAX) + '\n... [truncated config preview]'
      : raw;
    add('config', relative, base, `Config ${relative}:\n${text}`, file);
  }

  const chunks = [];
  for (const doc of docsFiles) {
    const parts = chunkText(doc.text).filter((part) => part && part.trim());
    parts.forEach((content, index) => {
      chunks.push({
        id: stableChunkId({
          repo: name,
          sourcePath: doc.path,
          chunkerVersion,
          ordinal: index,
          content,
        }),
        path: doc.path,
        kind: doc.kind,
        title: doc.title,
        chunk: index + 1,
        of: parts.length,
        embedText: `${doc.title} — ${doc.path}\n${content}`.slice(0, MAX_CHUNK_CHARS + 300),
        text: content,
        preview: content.trim().slice(0, 200).replace(/\s+/g, ' '),
      });
    });
  }

  return {
    allFiles,
    census,
    excluded,
    docsFiles,
    counts,
    intentionallySkipped,
    chunks,
    coveredPaths: new Set(docsFiles.map((doc) => doc.path)).size,
  };
}
