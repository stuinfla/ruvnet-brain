// tests/unit/lf-lines.test.mjs
//
// 4.7.31 HOTFIX: every existing install's update to 4.7.30 died in forge-guard ("PARITY 19,275 != 19,274", 2 invalid
// passages on the ruflo store). node:readline ends a line at U+2028 / U+2029 as well as LF, and JSON.stringify leaves
// both RAW inside a string; one ruflo passage carried a raw U+2028, so one JSONL record was read as two halves that
// both failed to parse. Fresh installs skip that gate, which is why install verification passed.
//
// These tests pin: the shared reader (plugin/scripts/lf-lines.mjs), the REAL forge-guard run exactly as the update
// path runs it (`node <candidate>/forge-guard.mjs --dir <candidate> --name <store>`, kb/forge-update.mjs
// validateFinalTree), forge-big's readPassages, and a census that no shipped JSONL reader goes back to readline.
// RNB_FORGE_GUARD_UNDER_TEST points the guard test at another copy (the 4.7.30 file) to show it fails there.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lfLines, lfLineReader } from '../../plugin/scripts/lf-lines.mjs';
import { readPassages } from '../../kb/forge-big.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = process.env.RNB_FORGE_GUARD_UNDER_TEST || path.join(ROOT, 'kb', 'forge-guard.mjs');
const temps = [];
afterAll(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

// Three records; two carry the separators RAW, exactly as JSON.stringify writes them.
const RECORDS = [
  { id: 0, path: 'a.md', text: `A fixture passage long enough to be a real passage, with a raw line separator here: and text after it.` },
  { id: 1, path: 'b.md', text: `A second passage, with a raw paragraph separator here: and more text after it, still one record.` },
  { id: 2, path: 'c.md', text: 'A third, ordinary passage with nothing unusual in it at all, ending cleanly.' },
];
const JSONL = `${RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`;

describe('the LF-only reader', () => {
  it('JSON.stringify really leaves U+2028/U+2029 raw (the premise of the defect)', () => {
    expect(JSONL).toContain(' ');
    expect(JSONL).toContain(' ');
  });
  it('lfLines yields one line per record, each parses, also across chunk boundaries and multibyte splits', async () => {
    const bytes = Buffer.from(JSONL, 'utf8');
    const chunks = []; for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7)); // splits inside U+2028's 3 bytes
    const lines = []; for await (const l of lfLines(Readable.from(chunks))) lines.push(l);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l))).toEqual(RECORDS);
  });
  it('lfLineReader emits one line per record and drops a trailing CR, like readline with crlfDelay', async () => {
    const lines = await new Promise((resolve) => {
      const got = []; lfLineReader(Readable.from([Buffer.from(JSONL.replace(/\n/g, '\r\n'))])).on('line', (l) => got.push(l)).on('close', () => resolve(got));
    });
    expect(lines.map((l) => JSON.parse(l))).toEqual(RECORDS);
  });
  it('kb/forge-big.mjs readPassages reads all three records and rejects none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-lf-big-')); temps.push(dir);
    const file = path.join(dir, 'x.passages.jsonl'); fs.writeFileSync(file, JSONL);
    const rows = await readPassages(file);
    expect(rows).toEqual(RECORDS);
    expect(rows.malformed).toEqual([]);
  });
});

describe('forge-guard, run the way the update path runs it', () => {
  it('counts one passage per record and finds no invalid passage (4.7.30: PARITY 4 != 3, 2 invalid)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-lf-guard-')); temps.push(dir);
    fs.writeFileSync(path.join(dir, 'fixture.passages.jsonl'), JSONL);
    fs.writeFileSync(path.join(dir, 'fixture.meta.json'), JSON.stringify({ model: 'x', dimensions: 3, metric: 'cosine',
      entries: Object.fromEntries(RECORDS.map((r) => [String(r.id), { preview: r.text.slice(0, 40) }])) }));
    fs.writeFileSync(path.join(dir, 'fixture.rvf'), 'not a real index'); // the live query fails here; parity is the point
    const r = spawnSync(process.execPath, [GUARD, '--dir', dir, '--name', 'fixture'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/parity OK: passages=3 == meta=3/);
    expect(out).not.toMatch(/PARITY: passages lines/);
    expect(out).not.toMatch(/empty\/invalid text/);
  }, 90_000);
});

describe('no shipped JSONL reader goes back to node:readline', () => {
  // Interactive prompts read a terminal, not JSONL; the measurement harnesses read a child's JSON-RPC stdout
  // and are never shipped as product behaviour. Everything else that reads lines must use LF-only reading.
  const ALLOWED = new Set(['bin/install.mjs', 'scripts/managed-terminal-input.mjs', 'scripts/model-router-setup.mjs',
    'scripts/brain-latency-50.mjs', 'scripts/recommendation-e2e.mjs', 'scripts/top100-benchmark.mjs',
    'scripts/recommendation-real-host.mjs', 'scripts/brain-novice-50.mjs']);
  it('kb/, plugin/, bin/ and scripts/ hold no other readline line reader', () => {
    const r = spawnSync('git', ['grep', '-l', '-E', "from 'node:readline|require\\('node:readline", '--', 'kb', 'plugin', 'bin', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
    const files = r.stdout.split('\n').filter(Boolean).filter((f) => !ALLOWED.has(f));
    expect(files).toEqual([]);
  });
});
