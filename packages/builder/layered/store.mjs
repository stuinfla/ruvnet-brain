// Writes layered.db, the L+ layered store (ported from the L+ prototype's build.mjs): L1 map (manifest,
// tool and command rows, each with a verbatim one-line description and its path:line), typed L1 links,
// L2 verbatim extracts by rule (every row's text is the exact line range of its file), the ADR index,
// the files themselves (L3, so `source_ruvnet` reads from the pack and never from disk) and the
// precomputed "ADRs that name this file" table (L4). Deterministic: regex and bracket matching only,
// no model, no network, no clock, no host or folder path; rows are inserted in a fixed order, so the
// same sources and recipe give the same bytes. Returns the coverage ledger (layered-coverage.json).
//
// The text every row is cut from is the source text AFTER the recipe's secret screen (the same
// redactSecrets the passages get, line breaks kept so line numbers stay true), and BEFORE the
// config truncation discover.mjs applies to passages (a manifest cut at 12,000 characters would no
// longer parse, and `source_ruvnet` would serve half a file).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';
import { hostileRule, redactSecrets } from '../screen.mjs';
import { identSplit, sha256, span, toLines } from '../../engine/layered/text.mjs';
import { extractCli, extractDefaults, extractEnv, extractMcp, extractSignatures, extractTests } from './extract-code.mjs';
import { extractDocNumbers, extractMarkers, extractStatus, isAdrPath } from './extract-docs.mjs';
import { parseCargo, parsePackageJson, parsePluginJson, parsePyproject, parseSetupPy, readmeFirstSentence } from './manifests.mjs';

// Format 2: file text is stored once, deflated (raw DEFLATE, level 9, Node's bundled zlib) in
// files.data; an L2 row keeps its line range, length (`chars`, in UTF-16 code units, as JavaScript
// counts) and sha256, and the reader cuts its text from the file. Format 1 (a second copy of every
// extract's text, the file text uncompressed) was never released.
export const LAYERED_FORMAT = 2;
export const FILE_CODEC = 'deflate-raw-9';
const pack = (text) => deflateRawSync(Buffer.from(text, 'utf8'), { level: 9 });
const TESTPATH = /(^|\/)(__tests__|tests?|benches|bench|fixtures|__mocks__|mocks?|e2e|spec)\/|\.(test|spec|bench)\.[cm]?[jt]sx?$|_test\.(rs|py)$|(^|\/)test_[^/]+\.py$/;
const MANIFEST = /(^|\/)(Cargo\.toml|package\.json|pyproject\.toml|setup\.py)$|(^|\/)\.(claude|codex)-plugin\/plugin\.json$/;
const DISTINCTIVE = (b) => b.length >= 8 && !/^(index|mod|lib|main|types|README|utils|config)\./i.test(b);

export function langOf(p) {
  if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|svelte|vue)$/.test(p)) return 'js';
  if (/\.rs$/.test(p)) return 'rs';
  if (/\.py$/.test(p)) return 'py';
  if (/\.(md|mdx|markdown|rst|txt)$/i.test(p)) return 'doc';
  if (/\.(sh|bash|zsh)$/.test(p)) return 'sh';
  if (/\.(toml|json|ya?ml)$/.test(p)) return 'cfg';
  return 'other';
}

const EXTRACTORS = {
  cli: { langs: ['js', 'rs', 'py'], trigger: /\boptions:\s*\[|\.(?:option|requiredOption)\(|#\[(?:arg|clap)\(|\.command\(\s*['"`]|\.add_argument\(|@(?:click|typer)\.|^\s*@(?:\w+\.)?(?:command|group)\(/m, run: (L, s, g) => extractCli(L, s, g) },
  mcp: { langs: ['js', 'rs', 'py'], trigger: /\b["']?(?:inputSchema|input_schema)["']?\s*[:=]|\.(?:tool|registerTool)\(\s*['"`]|^\s*@\w+\.tool\b|^\s*#\[tool\b/m, run: (L, s, g) => extractMcp(L, s, g) },
  defaults: { langs: ['js', 'rs', 'py'], trigger: /\bimpl(?:<[^>]*>)?\s+Default\s+for\b|^\s*(?:export\s+)?(?:pub\s+)?(?:const|static)\s+[A-Z][A-Z0-9_]{2,}\b|Field\(\s*default|#\[serde\([^)]*default|\?\?\s*[\d'"tf-]|\|\|\s*[\d'"]/m, run: (L, s, g) => extractDefaults(L, s, g) },
  env: { langs: ['js', 'rs', 'py', 'sh'], trigger: /process\.env|env::var|\benv!\(|os\.getenv|os\.environ|Deno\.env|\$\{[A-Z_][A-Z0-9_]*:?[-=]/, run: (L, s, g) => extractEnv(L, g) },
  signature: { langs: ['js', 'rs', 'py'], trigger: /^export\s|^module\.exports|^exports\.\w+\s*=|^\s*pub\s+(?:async\s+|unsafe\s+|const\s+|extern\s+"C"\s+)*(?:fn|struct|enum|trait|type|mod|union)\s|^(?:async\s+)?(?:def|class)\s+[A-Za-z]/m, run: (L, s, g) => extractSignatures(L, g) },
  test: { langs: ['js', 'rs', 'py'], trigger: /\b(?:it|test|describe)(?:\.\w+)?\(\s*['"`]|#\[(?:tokio::)?test\b|^\s*def\s+test_/m, run: (L, s, g) => extractTests(L, g) },
  marker: { langs: ['js', 'rs', 'py', 'sh', 'doc'], trigger: /todo!|unimplemented!|not\s+(?:yet\s+)?implemented|not\s+tested|not\s+measured|not\s+(?:yet\s+)?wired|\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|\bstub|placeholder|experimental|deferred/i, run: (L) => extractMarkers(L) },
  status: { langs: ['doc'], trigger: null, run: (L, s, g, p) => extractStatus(L, p) },
  'doc-number': { langs: ['doc'], trigger: /\d/, run: (L) => extractDocNumbers(L) },
};

const SCHEMA = (tokenizer) => `
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE repos(repo TEXT PRIMARY KEY, commit_sha TEXT, commit_date TEXT, carried INTEGER, files INTEGER);
CREATE TABLE files(repo TEXT, path TEXT, lang TEXT, lines INTEGER, chars INTEGER, data BLOB, PRIMARY KEY(repo, path));
CREATE TABLE l1(id INTEGER PRIMARY KEY, repo TEXT, kind TEXT, name TEXT, path TEXT, dir TEXT, src_path TEXT, line INTEGER, line_end INTEGER, text TEXT, value TEXT, source_kind TEXT, version TEXT, entry TEXT, flag TEXT);
CREATE TABLE edges(id INTEGER PRIMARY KEY, repo TEXT, src_l1 INTEGER, type TEXT, dst_name TEXT, dst_l1 INTEGER, external INTEGER, ev_path TEXT, ev_line INTEGER);
CREATE TABLE l2(id INTEGER PRIMARY KEY, kind TEXT, repo TEXT, path TEXT, line_start INTEGER, line_end INTEGER, anchor INTEGER, symbol TEXT, term TEXT, chars INTEGER, sha256 TEXT, l1_id INTEGER, is_test INTEGER, flag TEXT);
CREATE TABLE adr(repo TEXT, path TEXT, number TEXT, title TEXT, title_line INTEGER);
CREATE TABLE adr_names(repo TEXT, file TEXT, adr TEXT, number TEXT, line INTEGER, text TEXT);
CREATE VIRTUAL TABLE fts USING fts5(text, ident, symbol, path, content='', tokenize='${tokenizer}');
`;
// FTS rowid: an L1 row is 2*id, an L2 row is 2*id+1 (the index is contentless, so the row it points to
// is read from its own table).

function newLedger(snap, carried) {
  const ext = Object.fromEntries(Object.keys(EXTRACTORS).map((k) => [k, { files_scanned: 0, files_with_trigger: 0, files_with_rows: 0, items_found: 0, items_stored: 0, verbatim_failures: 0, duplicates_dropped: 0, files_trigger_no_rows: [] }]));
  return { commit: snap.meta.commit, commit_date: snap.meta.date, carried: !!carried, files_read: 0, secrets_redacted: 0, hostile_rows: 0, extractors: ext, l1: {} };
}

/** One repository into the store. `ins` holds the prepared statements; returns the repo's ledger. */
function writeRepo(db, ins, { snap, carried }, s) {
  const repo = snap.meta.repo;
  const cov = newLedger(snap, carried);
  const flagOf = (t) => (t && hostileRule(t, s.screen.hostile) ? 'hostile' : null);
  // The text each row is cut from: whole file, secrets screened, line breaks kept.
  const texts = new Map();
  for (const d of snap.docs) {
    const { text, hits } = redactSecrets(d.full ?? d.text, s.screen.secrets, s.screen.redaction);
    cov.secrets_redacted += hits.length;
    texts.set(d.rel, text);
  }
  const all = [...texts.keys()];
  const linesOf = new Map();
  const L = (p) => linesOf.get(p) ?? (linesOf.set(p, toLines(texts.get(p))), linesOf.get(p));
  for (const p of all) ins.file.run(repo, p, langOf(p), L(p).length, texts.get(p).length, pack(texts.get(p)));
  cov.files_read = all.length;
  ins.repo.run(repo, snap.meta.commit, snap.meta.date, carried ? 1 : 0, all.length);
  const addL1 = (row) => {
    const id = Number(ins.l1.run(repo, row.kind, row.name, row.path, row.dir, row.src, row.line, row.end, row.text, row.value, row.source, row.version ?? null, row.entry ?? null, flagOf(row.text)).lastInsertRowid);
    ins.fts.run(2 * id, row.ftsText, identSplit(row.ftsText), row.name, row.ftsPath ?? row.path);
    return id;
  };

  // ---- L1 from manifests ----
  const l1ByDir = new Map();
  const l1ByName = new Map();
  const pendingDeps = [];
  const wsDescs = [];
  const manifests = all.filter((p) => MANIFEST.test(p));
  cov.l1 = { manifests_found: manifests.length, l1_manifest_rows: 0, manifests_not_rows: [], description_sources: {} };
  const parsed = [];
  for (const p of manifests) {
    const text = texts.get(p);
    const m = p.endsWith('Cargo.toml') ? parseCargo(p, text) : p.endsWith('package.json') ? parsePackageJson(p, text) : p.endsWith('pyproject.toml') ? parsePyproject(p, text) : p.endsWith('setup.py') ? parseSetupPy(p, text) : parsePluginJson(p, text, all);
    if (m.error) {
      cov.l1.manifests_not_rows.push({ path: p, reason: m.error });
      continue;
    }
    const dir = path.posix.dirname(p);
    if (m.wsDesc) wsDescs.push({ dir: dir === '.' ? '' : dir, path: p, ...m.wsDesc });
    parsed.push(m);
  }
  for (const m of parsed) {
    const dir = m.kind === 'ruflo-plugin' || m.kind === 'codex-plugin' ? path.posix.dirname(path.posix.dirname(m.path)) : path.posix.dirname(m.path);
    const d = dir === '.' ? '' : dir;
    let text = null, value = null, line = null, srcPath = m.path, srcKind = null;
    if (m.desc !== null && m.desc !== undefined && m.descLine) {
      line = m.descLine; text = L(m.path)[line - 1]; value = m.desc; srcKind = `${m.path.split('/').pop()} description`;
    } else if (m.descInherited) {
      const ws = wsDescs.filter((w) => d.startsWith(w.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
      if (ws) { srcPath = ws.path; line = ws.line; text = L(ws.path)[line - 1]; value = ws.desc; srcKind = 'workspace.package description (inherited)'; }
    }
    if (!text) {
      const rp = (d ? `${d}/` : '') + 'README.md';
      const sent = texts.has(rp) && readmeFirstSentence(texts.get(rp));
      if (sent) { srcPath = rp; line = sent.line; text = sent.text; value = sent.sentence; srcKind = 'README first sentence'; }
    }
    cov.l1.description_sources[srcKind || 'none'] = (cov.l1.description_sources[srcKind || 'none'] || 0) + 1;
    const entry = m.bin ? JSON.stringify(m.bin) : m.main || null;
    const id = addL1({ kind: m.kind, name: m.name, path: m.path, dir: d, src: line ? srcPath : null, line, end: line, text, value, source: srcKind ? `${srcKind} @ ${srcPath}` : null, version: m.version, entry, ftsText: [m.name, value || ''].join(' — ') });
    cov.l1.l1_manifest_rows++;
    if (['crate', 'npm-package', 'ruflo-plugin', 'python-package'].includes(m.kind) || !l1ByDir.has(d)) l1ByDir.set(d, id);
    if (!l1ByName.has(m.name)) l1ByName.set(m.name, id);
    pendingDeps.push({ id, m });
  }
  for (const { id, m } of pendingDeps) {
    for (const dep of m.deps) {
      const target = l1ByName.get(dep.pkgAlias || dep.name);
      ins.edge.run(repo, id, `depends-on:${dep.kind}`, dep.name, target ?? null, target ? 0 : 1, m.path, dep.line);
    }
    for (const pr of m.provides || []) ins.edge.run(repo, id, pr.type, pr.dst, null, 0, pr.path, pr.line || 1);
  }
  // A gist source: one map row per gist file (its title, the first sentence of the file as the source
  // line, the gist's date and URL); the file's extracts belong to it.
  if (snap.meta.gists) {
    cov.l1.gist_rows = 0;
    for (const fp of Object.keys(snap.meta.gists).sort()) {
      if (!texts.has(fp)) continue;
      const g = snap.meta.gists[fp];
      const sent = readmeFirstSentence(texts.get(fp));
      const id = addL1({ kind: 'gist', name: String(g.title ?? fp), path: fp, dir: fp, src: sent ? fp : null, line: sent ? sent.line : null, end: sent ? sent.line : null, text: sent ? sent.text : null, value: String(g.title ?? fp), source: sent ? 'gist title + first sentence of the gist file' : 'gist title', version: g.updated ?? null, entry: g.url ?? null, ftsText: [g.title ?? fp, sent ? sent.text : ''].join(' — ') });
      l1ByDir.set(fp, id);
      cov.l1.gist_rows++;
    }
  }
  const dirs = [...l1ByDir.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const ownerOf = (p) => {
    for (const d of dirs) if (d === '' || p === d || p.startsWith(`${d}/`)) return l1ByDir.get(d);
    return null;
  };

  // ---- L2 verbatim extracts ----
  const l1Derived = [];
  for (const p of all) {
    const lang = langOf(p);
    const lines = L(p);
    const text = lines.join('\n');
    const isTest = TESTPATH.test(p) ? 1 : 0;
    const owner = ownerOf(p);
    if (lang === 'doc' && isAdrPath(p)) {
      const h = lines.findIndex((l) => /^#\s/.test(l));
      const num = (/ADR[-_ ]?0*(\d+)/i.exec(p.split('/').pop()) || /ADR[-_ ]?0*(\d+)/i.exec(h >= 0 ? lines[h] : '') || [])[1] || null;
      ins.adr.run(repo, p, num, h >= 0 ? lines[h] : null, h >= 0 ? h + 1 : null);
    }
    for (const [name, ex] of Object.entries(EXTRACTORS)) {
      if (!ex.langs.includes(lang)) continue;
      const c = cov.extractors[name];
      c.files_scanned++;
      const trig = name === 'status' ? isAdrPath(p) || /^#{1,6}\s.*\b(status|limitation|known)/im.test(text) : ex.trigger.test(text);
      if (trig) c.files_with_trigger++;
      let rows;
      try {
        rows = ex.run(lines, text, lang, p);
      } catch (e) {
        rows = [];
        c.files_trigger_no_rows.push(`${p} (extractor error: ${e.message.slice(0, 80)})`);
      }
      if (rows.length) c.files_with_rows++;
      else if (trig) c.files_trigger_no_rows.push(p);
      const seenRow = new Set();
      for (const r of rows) {
        c.items_found++;
        const rk = `${r.kind}|${r.line_start}|${r.line_end}|${r.symbol}`;
        if (seenRow.has(rk)) { c.duplicates_dropped++; continue; }
        seenRow.add(rk);
        if (!(r.line_start >= 1 && r.line_end >= r.line_start && r.line_end <= lines.length)) { c.verbatim_failures++; continue; }
        const t = span(lines, r.line_start, r.line_end);
        const flag = flagOf(t);
        if (flag) cov.hostile_rows++;
        const id = Number(ins.l2.run(r.kind, repo, p, r.line_start, r.line_end, r.anchor ?? null, r.symbol ?? null, r.term ?? null, t.length, sha256(t), owner, isTest, flag).lastInsertRowid);
        c.items_stored++;
        ins.fts.run(2 * id + 1, t, identSplit(`${r.symbol || ''} ${r.kind} ${r.term || ''} ${t}`), r.symbol || '', p);
        if (r.kind === 'command' && r.top && /\/commands\//.test(p)) {
          let e = r.descLine;
          const I = lines[r.descLine - 1].search(/\S/);
          while (e < lines.length && e - r.descLine < 14 && (lines[e].trim() === '' ? false : lines[e].search(/\S/) > I)) e++;
          l1Derived.push({ kind: 'cli-command', name: r.symbol, path: p, line: r.descLine, end: e, owner });
        }
        if (r.kind === 'mcp-tool' && !isTest) l1Derived.push({ kind: 'mcp-tool', name: r.symbol, path: p, line: r.descLine || r.line_start, end: Math.max(r.descLine || r.line_start, r.line_end), owner });
      }
    }
  }

  // ---- L1 rows for CLI command groups and MCP tools (verbatim description lines) ----
  const seen = new Set();
  cov.l1.cli_command_rows = 0;
  cov.l1.mcp_tool_rows = 0;
  for (const d of l1Derived) {
    const key = `${d.kind}|${d.name}|${d.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = span(L(d.path), d.line, d.end);
    const v = /description["']?\s*[:=]\s*(?:String::from\(|["'`])?([\s\S]*)$/.exec(text || '');
    const id = addL1({ kind: d.kind, name: d.name, path: d.path, dir: path.posix.dirname(d.path), src: d.path, line: d.line, end: d.end, text, value: v ? v[1] : null, source: d.kind === 'cli-command' ? 'command description field' : 'tool description field', ftsText: [d.name, text || ''].join(' — ') });
    if (d.owner) ins.edge.run(repo, id, d.kind === 'cli-command' ? 'command-in-package' : 'tool-in-package', null, d.owner, 0, d.path, d.line);
    cov.l1[d.kind === 'cli-command' ? 'cli_command_rows' : 'mcp_tool_rows']++;
  }
  // The repository's README first sentence.
  const rs = texts.has('README.md') && readmeFirstSentence(texts.get('README.md'));
  if (rs) addL1({ kind: 'repository', name: repo, path: 'README.md', dir: '', src: 'README.md', line: rs.line, end: rs.line, text: rs.text, value: rs.sentence, source: 'README first sentence', ftsText: `${repo} ${rs.text}` });

  // ---- L4: ADR lines that name a file of this repository (the prototype scanned the ADRs per call) ----
  const byBase = new Map();
  for (const p of all) {
    const b = path.posix.basename(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  const adrs = all.filter((p) => langOf(p) === 'doc' && isAdrPath(p));
  for (const a of adrs) {
    const num = (/ADR[-_ ]?0*(\d+)/i.exec(a.split('/').pop()) || [])[1] ?? null;
    const named = new Set();
    L(a).forEach((l, i) => {
      for (const tok of new Set(l.match(/[\w./-]+\.[A-Za-z0-9]+/g) ?? [])) {
        const b = path.posix.basename(tok);
        for (const f of byBase.get(b) ?? []) {
          if (f === a || named.has(f)) continue;
          if (!(l.includes(f) || DISTINCTIVE(b))) continue;
          named.add(f);
          ins.adrName.run(repo, f, a, num, i + 1, l.length > 400 ? null : l);
        }
      }
    });
  }
  for (const c of Object.values(cov.extractors)) {
    c.files_trigger_no_rows_count = c.files_trigger_no_rows.length;
    c.files_trigger_no_rows = c.files_trigger_no_rows.slice(0, 50);
  }
  return cov;
}

/** The layered store, written one repository at a time: addRepo({ snap, carried }) in repository
 *  order, then finish() returns the coverage ledger. `s` is the builder's settings (s.layered and
 *  s.screen from the recipe). Nothing of a repository is kept after its addRepo returns. */
export function openLayeredStore(file, s) {
  if (!/^[a-z0-9_ ]+$/.test(s.layered.fts5Tokenizer)) throw new Error(`layered.fts5Tokenizer "${s.layered.fts5Tokenizer}" is not a plain tokenizer name`);
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  const coverage = { schema: 'ruvnet-brain/layered-coverage', version: 1, note: 'Per repository and extractor. items_found = rows an extractor produced; items_stored = rows written (fewer only for duplicates or a range outside the file). files_trigger_no_rows = files where the extractor\'s trigger matches but it produced no row (first 50 listed). Files skipped before extraction are listed in manifest.json.', repos: {} };
  let ins;
  try {
    db.exec(SCHEMA(s.layered.fts5Tokenizer));
    ins = {
      repo: db.prepare('INSERT INTO repos VALUES (?,?,?,?,?)'),
      file: db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?)'),
      l1: db.prepare('INSERT INTO l1(repo,kind,name,path,dir,src_path,line,line_end,text,value,source_kind,version,entry,flag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      edge: db.prepare('INSERT INTO edges(repo,src_l1,type,dst_name,dst_l1,external,ev_path,ev_line) VALUES (?,?,?,?,?,?,?,?)'),
      l2: db.prepare('INSERT INTO l2(kind,repo,path,line_start,line_end,anchor,symbol,term,chars,sha256,l1_id,is_test,flag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      adr: db.prepare('INSERT INTO adr VALUES (?,?,?,?,?)'),
      adrName: db.prepare('INSERT INTO adr_names VALUES (?,?,?,?,?,?)'),
      fts: db.prepare('INSERT INTO fts(rowid,text,ident,symbol,path) VALUES (?,?,?,?,?)'),
    };
    db.exec('BEGIN');
  } catch (e) {
    db.close();
    throw e;
  }
  return {
    addRepo(r) {
      coverage.repos[r.snap.meta.repo] = writeRepo(db, ins, r, s);
    },
    abort() {
      try {
        db.close();
      } catch {}
    },
    finish() {
      try {
        db.exec("UPDATE edges SET dst_name=(SELECT name FROM l1 WHERE l1.id=edges.dst_l1) WHERE dst_name IS NULL");
        db.exec('CREATE INDEX l2_path ON l2(repo,path,line_start); CREATE INDEX l2_kind ON l2(kind); CREATE INDEX l2_l1 ON l2(l1_id); CREATE INDEX l2_sym ON l2(symbol); CREATE INDEX e_src ON edges(src_l1); CREATE INDEX e_dst ON edges(dst_l1); CREATE INDEX l1_name ON l1(name); CREATE INDEX adr_num ON adr(repo,number); CREATE INDEX adr_names_file ON adr_names(repo,file)');
        const meta = db.prepare('INSERT INTO meta VALUES (?,?)');
        meta.run('format', String(LAYERED_FORMAT));
        meta.run('fts5Tokenizer', s.layered.fts5Tokenizer);
        meta.run('fileCodec', FILE_CODEC);
        db.exec('COMMIT');
        db.exec("INSERT INTO fts(fts) VALUES ('optimize')");
        coverage.counts = {
          l1: db.prepare('SELECT repo, kind, count(*) n FROM l1 GROUP BY repo, kind ORDER BY repo, kind').all().map((x) => ({ ...x })),
          edges: db.prepare('SELECT repo, type, count(*) n, sum(external) external FROM edges GROUP BY repo, type ORDER BY repo, type').all().map((x) => ({ ...x })),
          l2: db.prepare('SELECT repo, kind, count(*) n FROM l2 GROUP BY repo, kind ORDER BY repo, kind').all().map((x) => ({ ...x })),
          adr: db.prepare('SELECT repo, count(*) n FROM adr GROUP BY repo ORDER BY repo').all().map((x) => ({ ...x })),
        };
        db.exec('VACUUM');
      } finally {
        db.close();
      }
      return coverage;
    },
  };
}

/** results: [{ snap, carried }] sorted by repo: the whole store at once. Returns the coverage ledger. */
export function writeLayered(file, results, s) {
  const w = openLayeredStore(file, s);
  try {
    for (const r of results) w.addRepo(r);
  } catch (e) {
    w.abort();
    throw e;
  }
  return w.finish();
}
