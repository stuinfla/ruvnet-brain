#!/usr/bin/env node
// build-l2.mjs — L2 concept/synthesis layer (the validated closer for overview/playbook questions).
// For a synthesis topic: retrieve the real source (rerankKb), have a strong LLM SYNTHESIZE a complete,
// prescriptive, source-CITED article using ONLY that source, validate the citations are real, then
// GRADE the article with the 3-vendor panel (does it now fully answer?). Proves L2 closes Q5/Q7/Q8.
//
//   node scripts/build-l2.mjs --name ruflo --variant big
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rerankKb } from '../kb/forge-rerank.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NAME = arg('--name', 'ruflo'), VARIANT = arg('--variant', 'big');
const GEN_MODEL = arg('--gen', 'anthropic/claude-3.5-sonnet');
const JUDGES = ['openai/gpt-4o-mini', 'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct'];
const REPO = '/Users/stuartkerr/Code/ruvnet-repos/ruflo';
const KEY = process.env.OPENROUTER_API_KEY || (fs.readFileSync((process.env.RUVNET_ENV_FILE || '.env'), 'utf8').match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();

// Per-repo synthesis topics: prefer kb/l2-topics.<name>.json ([{slug,q},...] — the graded synthesis
// gaps), else fall back to the original ruflo defaults so existing behavior is unchanged.
const RUFLO_DEFAULT = [
  { slug: 'guidance-mechanism', q: 'How does the guidance system produce a recommendation (guidance_recommend) — what is the mechanism?' },
  { slug: 'adr-coverage', q: "Where are ruflo's ADRs kept and what areas do they cover?" },
  { slug: 'memory-end-to-end', q: "How do I initialize and use ruflo's memory in a project end-to-end?" },
];
const TOPICS_FILE = path.join(ROOT, 'kb', `l2-topics.${NAME}.json`);
const TOPICS = fs.existsSync(TOPICS_FILE) ? JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')) : RUFLO_DEFAULT;

async function or(model, sys, usr, max = 1400) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0, max_tokens: max }),
  });
  if (!r.ok) throw new Error(`${model} HTTP ${r.status}`);
  return (await r.json()).choices?.[0]?.message?.content || '';
}

fs.mkdirSync(path.join(ROOT, 'kb/l2'), { recursive: true });
for (const t of TOPICS) {
  const hits = await rerankKb({ dir: path.join(ROOT, 'kb'), name: NAME, query: t.q, k: 8, variant: VARIANT });
  const allowed = new Set(hits.map((h) => h.path));
  const ctx = hits.map((h, i) => `[SOURCE ${i + 1}] ${h.path}\n${(h.fullText || '').slice(0, 2400)}`).join('\n\n');
  const paths = hits.map((h) => h.path);
  const sys = 'You are Ruv writing the authoritative internal explainer. Using ONLY the SOURCE excerpts provided, write a complete, prescriptive, actionable answer. You MUST cite real file paths inline in backticks for EVERY major claim, referencing at least 3 distinct SOURCE paths verbatim. Do NOT invent files or facts. If a part is not covered by the sources, say so explicitly rather than guessing.';
  // ground-truth citation check: count how many of the PROVIDED source paths the article actually references
  const countRefs = (txt) => [...new Set(paths.filter((p) => txt.includes(p) || txt.includes(p.split('/').pop())))];
  const gen = (extra) => or(GEN_MODEL, sys + extra, `QUESTION: ${t.q}\n\nSOURCE PATHS YOU MUST CITE FROM (verbatim):\n${paths.map((p) => '- ' + p).join('\n')}\n\nSOURCES:\n${ctx}`, 1500)
    .catch(() => or('openai/gpt-4o-mini', sys + extra, `QUESTION: ${t.q}\n\nSOURCES:\n${ctx}`, 1500));
  let article = await gen('');
  let realCited = countRefs(article);
  if (realCited.length < 2) { article = await gen(' YOUR LAST ATTEMPT CITED TOO FEW REAL FILES — REJECTED. Cite at least 3 of the exact SOURCE PATHS listed above, verbatim, in backticks.'); realCited = countRefs(article); }
  const accepted = realCited.length >= 2;                    // ADR-0002 R1: enforce grounding or REJECT
  const odir = accepted ? 'l2' : 'l2/rejected';
  fs.mkdirSync(path.join(ROOT, 'kb', odir), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'kb', odir, `${t.slug}.md`), `# ${t.q}\n\n<!-- L2 synthesis · ${accepted ? 'ACCEPTED' : 'REJECTED (ungrounded)'} · ${realCited.length} verified source refs: ${realCited.slice(0, 5).join(', ')} -->\n\n${article}\n`);

  // grade the article as the answer (3-vendor)
  const jsys = 'Grade 1-100 whether this answer COMPLETELY and CORRECTLY answers the question (98=perfect/complete/actionable; incomplete-but-not-wrong=POISON<50). Return ONLY {"score":N,"reason":"<=15 words"}.';
  const scores = [];
  for (const j of JUDGES) {
    try { const o = JSON.parse((await or(j, jsys, `QUESTION: ${t.q}\n\nANSWER:\n${article}`, 120)).match(/\{[\s\S]*\}/)[0]); scores.push(Number(o.score)); }
    catch { /* skip */ }
  }
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  console.log(`\n## ${t.slug}  [${accepted ? 'ACCEPTED' : 'REJECTED — ungrounded'}]`);
  console.log(`   verified source refs: ${realCited.length} (${realCited.slice(0, 4).join(', ')})`);
  console.log(`   3-vendor answer score: [${scores.join(', ')}] → avg ${avg?.toFixed(1)}`);
}
console.log('\nL2 articles written to kb/l2/. (Integration: include kb/l2 in the next KB rebuild so they are retrievable.)');
