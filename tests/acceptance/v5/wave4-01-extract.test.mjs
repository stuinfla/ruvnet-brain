// Wave 4 (L+ port), test 1: the layered builder's extracts are verbatim and complete.
//   - every L2 row's text is exactly its file's line range, read back from disk by this test's own
//     line split (not the product's), and its sha256 is that text's;
//   - every L1 source_line is exactly the line at source_path:line;
//   - each extractor kind fires on the fixture with the expected row (flag with its default, MCP tool
//     and schema, const, object default, Rust impl Default field, env, signature, status, doc number,
//     marker, test, Python argparse flag), and manifest links resolve inside the repository;
//   - a secret in the source never reaches the store: the line is kept (line numbers stay true) with
//     the recipe's redaction in place of the key, and the key's bytes appear nowhere in layered.db;
//   - a manifest longer than the passage truncation (12,000 characters) still parses into an L1 row;
//   - the same sources and recipe give byte-identical layered.db and layered-coverage.json.
// Breaks (breaks-wave4.mjs): a span one line too long; redaction skipped; the truncated text used.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { setup } from './helpers.mjs';
import { built } from './wp5-helpers.mjs';
import { FAKE_AWS, KIT_META, fileLines, writeKit } from './wave4-helpers.mjs';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// A package.json whose description comes after 13,000+ characters of keywords.
const BIG = JSON.stringify({ name: '@lplus/big', version: '0.0.1', keywords: Array.from({ length: 900 }, (_, i) => `keyword-number-${i}`), description: 'A package whose description sits past the truncation point' }, null, 2) + '\n';

test('Wave 4: layered extracts are verbatim, screened, complete and deterministic', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wave4-01');
  const tree = ctx.tree();
  const kit = writeKit(ctx, { 'packages/big/package.json': BIG });
  assert.ok(BIG.length > 13_000, 'the big manifest must be over the 12,000-character truncation');
  const pack = built(ctx, tree, { sources: [kit] });
  const db = new DatabaseSync(path.join(pack, 'layered.db'), { readOnly: true });
  t.after(() => db.close());
  const lines = new Map();
  const disk = (p) => lines.get(p) ?? (lines.set(p, fileLines(path.join(kit, p))), lines.get(p));
  const redactedLine = (p, n) => disk(p)[n - 1].replaceAll(FAKE_AWS, '[redacted]');

  // Every L2 row: verbatim from disk (with the redaction the recipe applies), hash of the text stored.
  // Format 2: a file's text is stored once, deflated; an extract is its line range of that file, with its
  // length and sha256. This test inflates the file and cuts the range with its own line split.
  const fileText = (p) => inflateRawSync(db.prepare('SELECT data FROM files WHERE path=?').get(p).data).toString('utf8');
  const cut = (p, a, b) => {
    const ls = fileText(p).split('\n');
    return ls.slice(a - 1, b).join('\n');
  };
  const l2 = db.prepare('SELECT * FROM l2 ORDER BY id').all().map((r) => ({ ...r, text: cut(r.path, r.line_start, r.line_end) }));
  assert.ok(l2.length >= 25, `the fixture yields many rows (${l2.length})`);
  for (const r of l2) {
    const want = Array.from({ length: r.line_end - r.line_start + 1 }, (_, k) => redactedLine(r.path, r.line_start + k)).join('\n');
    assert.equal(r.text, want, `verbatim: ${r.kind} ${r.symbol} at ${r.path}:${r.line_start}-${r.line_end}`);
    assert.equal(r.sha256, sha(r.text), `sha256 of ${r.path}:${r.line_start}`);
    assert.equal(r.chars, r.text.length, `stored length of ${r.path}:${r.line_start}`);
  }
  // Every L1 row with a source line: that exact line.
  const l1 = db.prepare('SELECT * FROM l1 ORDER BY id').all();
  for (const r of l1.filter((x) => x.line)) assert.equal(r.text.split('\n')[0], redactedLine(r.src_path, r.line), `verbatim L1 ${r.kind} ${r.name} at ${r.src_path}:${r.line}`);

  // Each extractor kind, with the row a reader would cite.
  const row = (kind, symbol) => l2.find((r) => r.kind === kind && r.symbol === symbol);
  const at = (r) => r && `${r.path}:${r.line_start}-${r.line_end}`;
  assert.equal(at(row('flag', 'memory --max-agents')), 'src/commands/memory.ts:7-7');
  assert.match(row('flag', 'memory --max-agents').term, /^default=8$/);
  assert.equal(at(row('command', 'memory')), 'src/commands/memory.ts:4-5');
  assert.equal(at(row('mcp-tool', 'memory_store')), 'src/mcp/tools.ts:3-4');
  assert.equal(at(row('mcp-schema', 'memory_store')), 'src/mcp/tools.ts:5-9');
  assert.equal(at(row('const', 'DEFAULT_TTL_MS')), 'src/config.ts:2-2');
  assert.equal(at(row('default', 'MemoryConfig.ttl')), 'src/config.ts:4-4');
  assert.equal(at(row('default', 'HnswConfig.ef_search')), 'crates/hnsw/src/lib.rs:9-9');
  assert.equal(at(row('env', 'LPLUS_TOKEN')), 'src/config.ts:8-8');
  assert.equal(at(row('env', 'HNSW_THREADS')), 'crates/hnsw/src/lib.rs:15-15');
  assert.equal(at(row('signature', 'storeEpisode')), 'src/config.ts:10-11');
  assert.equal(at(row('status', 'Status')), 'docs/adr/ADR-007-memory-ttl.md:3-3');
  assert.ok(l2.some((r) => r.kind === 'doc-number-line' && r.path === 'docs/adr/ADR-007-memory-ttl.md' && r.line_start === 8), 'the doc line stating the default ttl');
  assert.ok(l2.some((r) => r.kind === 'marker' && r.symbol === 'not implemented' && r.term === 'not implemented|TODO' && r.anchor === 12 && r.path === 'src/config.ts' && r.line_start === 9 && r.line_end === 14), 'the TODO / not implemented marker with its anchor line and 3 lines either side');
  assert.equal(at(row('test', 'stores an episode with the default ttl')), 'src/config.test.ts:3-3');
  assert.equal(row('test', 'stores an episode with the default ttl').is_test, 1);
  assert.equal(at(row('test', 'finds_neighbours')), 'crates/hnsw/src/lib.rs:19-20');
  assert.equal(at(row('flag', '--top-k')), 'tools/cli.py:4-4');
  const kinds = new Set(l2.map((r) => r.kind));
  for (const k of ['status', 'marker', 'command', 'flag', 'mcp-tool', 'mcp-schema', 'default', 'const', 'env', 'signature', 'doc-number-line', 'test']) assert.ok(kinds.has(k), `extractor kind ${k} produced a row`);

  // L1 map and links.
  const l1n = (kind, name) => l1.find((r) => r.kind === kind && r.name === name);
  assert.equal(l1n('npm-package', 'lplus-kit')?.value, 'Agent toolkit with episodic memory and a swarm CLI');
  assert.equal(l1n('crate', 'lplus-hnsw')?.value, 'Layered HNSW index for lplus-kit');
  assert.ok(l1n('cli-command', 'memory') && l1n('mcp-tool', 'memory_store') && l1n('repository', 'lplus-kit'), 'command, tool and repository rows');
  const dep = db.prepare("SELECT * FROM edges WHERE type='depends-on:dependencies' AND dst_name='@lplus/core'").get();
  assert.equal(dep?.dst_l1, l1n('npm-package', '@lplus/core').id, 'an in-repository dependency links to its L1 row');
  assert.equal(dep.external, 0);
  assert.equal(db.prepare("SELECT external FROM edges WHERE dst_name='zod'").get()?.external, 1, 'an outside dependency is marked external');

  // The untruncated manifest: an L1 row from a description past 12,000 characters, read in full.
  const big = l1n('npm-package', '@lplus/big');
  assert.ok(big, 'a manifest over the passage truncation still becomes an L1 row (it was parsed untruncated)');
  assert.equal(big.value, 'A package whose description sits past the truncation point');
  assert.equal(fileText('packages/big/package.json'), BIG, 'the store holds the whole manifest');

  // Secrets: the key is gone from the store, its line is kept.
  const bytes = fs.readFileSync(path.join(pack, 'layered.db'));
  assert.equal(bytes.includes(Buffer.from(FAKE_AWS)), false, 'no secret key bytes anywhere in layered.db');
  // File text is stored deflated, so the raw bytes alone cannot show a leak: every file is inflated too.
  for (const { path: fp } of db.prepare('SELECT path FROM files').all()) assert.equal(fileText(fp).includes(FAKE_AWS), false, `no secret key in the stored text of ${fp}`);
  assert.equal(fileText('src/config.ts').split('\n')[6], "const fallbackKey = '[redacted]';", 'the redacted line keeps its place');
  assert.ok(bytes.length < 400_000, `the store is compact (${bytes.length} bytes)`);
  const cov = JSON.parse(fs.readFileSync(path.join(pack, 'layered-coverage.json'), 'utf8'));
  assert.equal(cov.repos['lplus-kit'].secrets_redacted, 1, 'the coverage ledger counts the redaction');
  assert.equal(cov.repos['lplus-kit'].commit, KIT_META.commit, 'the coverage ledger records the commit per repository');
  assert.ok(cov.repos['lplus-kit'].extractors.cli.items_stored >= 3, 'per-extractor counts are recorded');
  assert.equal(JSON.stringify(cov).includes(kit), false, 'no folder path in the coverage ledger');

  // The hostile line is stored, flagged, never dropped.
  assert.ok(l2.some((r) => r.path === 'docs/NOTES.md' && r.flag === 'hostile'), 'a row holding a prompt-injection line is flagged hostile');

  // Deterministic: a second build of the same sources gives the same bytes.
  const again = built(ctx, tree, { sources: [kit] });
  for (const f of ['layered.db', 'layered-coverage.json']) assert.equal(sha(fs.readFileSync(path.join(again, f))), sha(fs.readFileSync(path.join(pack, f))), `${f} is byte-identical across builds`);
  const roles = JSON.parse(fs.readFileSync(path.join(pack, 'PACK.json'), 'utf8')).files.map((f) => `${f.path}:${f.role}`);
  assert.ok(roles.includes('layered.db:layered-db') && roles.includes('layered-coverage.json:layered-coverage'), `PACK.json lists the layered files with their roles: ${roles}`);
});
