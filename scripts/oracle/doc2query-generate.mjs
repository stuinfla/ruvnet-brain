#!/usr/bin/env node
/**
 * scripts/oracle/doc2query-generate.mjs — ADR-099 arm A, generation: newcomer-style questions per
 * documentation file ("doc2query"), produced ONCE where the corpus is built, never on a customer
 * machine.
 *
 * The generator sees only the file's title, path and opening text, never the need set. Each question
 * must describe a NEED in plain words. Deterministic checks drop any question that:
 *   - names the product, the repository or a code identifier, or
 *   - shares more than 3 consecutive words with the excerpt
 * (the need-set producer's leak rules). Output is append-only JSONL
 * {store, path, questions[], rejected}, so a run can be resumed and interrupted runs keep their work.
 *
 *   node scripts/oracle/doc2query-generate.mjs --kb <kbDir> --stores ruflo,ruvector,ruview --out <file.jsonl>
 *     [--kind md] [--per-file 3] [--batch 25] [--model haiku] [--limit N] [--conc 2]
 *
 * Children run with scripts/subscription-hosts.mjs#subscriptionOnlyEnv (no API billing keys) and the
 * same minimised-context claude flags as scripts/oracle/producer-hosts.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { claudeArgs, spawnHost, isQuotaRefusal } from './producer-hosts.mjs';
import { subscriptionOnlyEnv } from '../subscription-hosts.mjs';

export const EXCERPT_CHARS = 1500;
export const D2Q_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { docId: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } } },
    required: ['docId', 'questions'] } } },
  required: ['items'],
});
export const D2Q_SYSTEM = 'You write search questions for documentation. You see only the documents in the message, '
  + 'you have no tools, and you use no outside knowledge. Return only the structured output.';

export function d2qPrompt(docs, perFile) {
  return [
    `For each DOC below write ${perFile} different questions that a newcomer might type into a search box, `
      + 'where this document is what would help them.',
    'Rules for every question:',
    '- 12-35 words, plain everyday language, describing the person\'s NEED or problem, not the document.',
    '- The person has never heard of this project: no product, project, repository, package, library or tool names, no code, no identifiers, no file names.',
    '- Do not copy more than 3 consecutive words from the document.',
    '- The three questions should cover different things the document helps with.',
    'Return one item per DOC with its docId copied exactly.',
    '',
    ...docs.map((d) => `===DOC docId=${d.docId}\ntitle: ${d.title}\n${d.excerpt}\n===END`),
  ].join('\n');
}

const PRODUCT_NAME = /^(?:ruv\w*|ruflo|rufl\w*|ruview|claudeflow|agentdb|agentic|sona|rvf|ruvllm|cognitum|densepose|metaharness|reasoningbank)$/;
const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
/** Longest run of consecutive words a question shares with the excerpt. */
export function sharedRun(question, excerpt) {
  const q = words(question);
  const grams = new Set();
  const e = words(excerpt);
  let best = 0;
  for (let n = 1; n <= q.length; n++) {
    grams.clear();
    for (let i = 0; i + n <= e.length; i++) grams.add(e.slice(i, i + n).join(' '));
    let found = false;
    for (let i = 0; i + n <= q.length; i++) if (grams.has(q.slice(i, i + n).join(' '))) { found = true; break; }
    if (!found) break;
    best = n;
  }
  return best;
}

/** Keep a question only if it obeys the leak rules; return the reason when it does not. */
export function leakReason(question, { excerpt, store, path: p }) {
  const q = String(question || '').trim();
  const n = words(q).length;
  if (n < 8 || n > 45) return 'length';
  if (/[`{}<>=]|::|\w\(|\b[a-z]+[A-Z][A-Za-z]+\b|\b\w+\.(?:md|js|ts|rs|py|json|toml)\b|@[a-z0-9-]+\//.test(q)) return 'identifier';
  // Product names: the store itself and the rUv family's own names (a newcomer has heard none of them).
  if (words(q).some((w) => w === String(store).toLowerCase() || PRODUCT_NAME.test(w))) return 'names-source';
  void p;
  if (sharedRun(q, excerpt) > 3) return 'copies-source';
  return null;
}

export function excerptOf(chunks) {
  return chunks.join('\n\n').slice(0, EXCERPT_CHARS);
}

function readStoreDocs(kb, store, kind) {
  const big = path.join(kb, `${store}.big.passages.jsonl`);
  const file = fs.existsSync(big) ? big : path.join(kb, `${store}.passages.jsonl`);
  const byPath = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (kind === 'md' && !/\.md$/i.test(r.path)) continue;
    if (!byPath.has(r.path)) byPath.set(r.path, { title: r.title || path.basename(r.path), chunks: [] });
    const d = byPath.get(r.path);
    if (d.chunks.join('').length < EXCERPT_CHARS) d.chunks.push(String(r.text || ''));
  }
  return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([p, d]) => ({ store, path: p, title: d.title, excerpt: excerptOf(d.chunks) }));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const kb = arg('--kb');
  const out = arg('--out');
  const perFile = Number(arg('--per-file', 3));
  const batchSize = Number(arg('--batch', 25));
  const conc = Number(arg('--conc', 2));
  const model = arg('--model', 'haiku');
  const done = new Set();
  if (fs.existsSync(out)) {
    for (const l of fs.readFileSync(out, 'utf8').split('\n')) { try { const r = JSON.parse(l); done.add(`${r.store}|${r.path}`); } catch { /* partial */ } }
  }
  let docs = String(arg('--stores')).split(',').flatMap((s) => readStoreDocs(kb, s.trim(), arg('--kind', 'md')))
    .filter((d) => !done.has(`${d.store}|${d.path}`));
  if (arg('--limit')) docs = docs.slice(0, Number(arg('--limit')));
  const batches = [];
  for (let i = 0; i < docs.length; i += batchSize) batches.push(docs.slice(i, i + batchSize));
  const env = { ...subscriptionOnlyEnv(), CLAUDE_HOOK: '/usr/bin/true' };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd2q-'));
  let next = 0;
  let stop = false;
  let written = 0;
  const worker = async () => {
    while (!stop && next < batches.length) {
      const b = batches[next++];
      const withIds = b.map((d, i) => ({ ...d, docId: `d${i}` }));
      const res = await spawnHost('claude', claudeArgs({ model, effort: 'low', schema: D2Q_SCHEMA, systemPrompt: D2Q_SYSTEM }),
        { cwd, env, timeoutMs: 600_000 }, d2qPrompt(withIds, perFile));
      let items = null;
      try {
        const env2 = JSON.parse(res.stdout);
        items = (env2.structured_output || JSON.parse(env2.result)).items;
      } catch { items = null; }
      if (!items) {
        if (isQuotaRefusal(res.stdout + res.stderr)) { stop = true; process.stderr.write('\n[d2q] quota refusal: stopping\n'); }
        else process.stderr.write(`\n[d2q] batch failed (status ${res.status}${res.timedOut ? ', timeout' : ''})\n`);
        continue;
      }
      const byId = new Map(items.map((it) => [it.docId, it.questions || []]));
      const lines = withIds.map((d) => {
        const qs = byId.get(d.docId) || [];
        const kept = [];
        const rejected = [];
        for (const q of qs) { const why = leakReason(q, d); if (why) rejected.push({ q, why }); else kept.push(q); }
        return JSON.stringify({ store: d.store, path: d.path, questions: kept, rejected });
      });
      fs.appendFileSync(out, `${lines.join('\n')}\n`);
      written += lines.length;
      process.stderr.write(`\r[d2q] ${written}/${docs.length} files`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  console.log(JSON.stringify({ files: docs.length, written, stopped: stop }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
