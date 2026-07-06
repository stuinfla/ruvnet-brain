#!/usr/bin/env node
// build-primer.mjs — per-repo top-down PRIMER (the 6 comprehension archetypes), grounded.
// Same proven shape as build-l2: for each archetype, retrieve the real source (rerankKb), have a
// strong LLM synthesize a prescriptive, source-CITED section using ONLY that source, then assemble
// the sections into kb/<name>-primer.md and verify the whole primer cites >= MIN real files.
//
// The "capabilities" archetype is deliberate: it produces PROSE that names each real capability with
// the file that implements it — the high-confidence retrieval target that makes an assistant STOP
// doubting code-implemented capabilities (the capability-confidence gap measured on ruflo/rulake).
//
//   node scripts/build-primer.mjs --name ruflo --variant big
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rerankKb } from '../kb/forge-rerank.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NAME = arg('--name', 'ruflo'), VARIANT = arg('--variant', 'big');
const KEY = process.env.OPENROUTER_API_KEY || (fs.readFileSync((process.env.RUVNET_ENV_FILE || '.env'), 'utf8').match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!KEY) { console.error('No OPENROUTER_API_KEY'); process.exit(2); }
const GEN_MODEL = arg('--gen', 'deepseek/deepseek-chat');
const JUDGES = ['openai/gpt-4o-mini', 'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct'];

// The 6 archetypes a raw repo can't answer top-down. {key,title,q}. The capabilities section is #2.
const ARCHES = [
  { key: 'what', title: 'What it is & who it\'s for', q: `What is ${NAME} and who is it for?` },
  { key: 'capabilities', title: 'Capabilities (what it can do)', q: `What can ${NAME} actually do? List its main capabilities, and for EACH name the source file that implements it.` },
  { key: 'concepts', title: 'Core concepts & how they work', q: `What are ${NAME}'s core concepts and how does each one work?` },
  { key: 'maturity', title: 'Maturity (shipped vs proposed)', q: `How mature is ${NAME}? Which features are shipped/accepted vs proposed (cite ADR status)?` },
  { key: 'docs', title: 'Where the documentation lives', q: `Where is ${NAME}'s documentation organized (guides, ADRs, references)?` },
  { key: 'use', title: 'How to use it end-to-end', q: `How do I install and use ${NAME} end-to-end?` },
];

async function or(model, sys, usr, max = 1500) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0, max_tokens: max }),
  });
  if (!r.ok) throw new Error(`${model} HTTP ${r.status}`);
  return (await r.json()).choices?.[0]?.message?.content || '';
}

const KB = path.join(ROOT, 'kb');
const allPaths = new Set();
let sections = [];
for (const a of ARCHES) {
  const hits = await rerankKb({ dir: KB, name: NAME, query: a.q, k: 8, variant: VARIANT });
  const paths = hits.map((h) => h.path);
  paths.forEach((p) => allPaths.add(p));
  const ctx = hits.map((h, i) => `[SOURCE ${i + 1}] ${h.path}\n${(h.fullText || '').slice(0, 2200)}`).join('\n\n');
  const sys = `You are Ruv writing the authoritative primer for ${NAME}. Using ONLY the SOURCE excerpts, write the "${a.title}" section: complete, prescriptive, and CONFIDENT about what exists. Cite real file paths inline in backticks for every concrete claim (cite >= 2 distinct SOURCE paths verbatim). For capabilities, state plainly that the feature EXISTS and point to the implementing file — never hedge about whether it can do something the source shows. If something is genuinely not covered, say so; do not invent.`;
  let body = await or(GEN_MODEL, sys, `SECTION: ${a.title}\nQUESTION: ${a.q}\n\nSOURCE PATHS (cite verbatim):\n${paths.map((p) => '- ' + p).join('\n')}\n\nSOURCES:\n${ctx}`)
    .catch(() => or('openai/gpt-4o-mini', sys, `QUESTION: ${a.q}\n\nSOURCES:\n${ctx}`));
  sections.push(`## ${a.title}\n\n${body.trim()}\n`);
  console.log(`  [${NAME}] section "${a.key}" — ${body.length} chars, ${paths.length} sources`);
}

const primer = `# ${NAME} — Primer\n\n<!-- Generated primer · grounded in real source via rerankKb (${VARIANT}) · archetypes: ${ARCHES.map(a => a.key).join(', ')} -->\n\n${sections.join('\n')}`;
const countRefs = (txt) => [...new Set([...allPaths].filter((p) => txt.includes(p) || txt.includes(p.split('/').pop())))];
const refs = countRefs(primer);
const outFile = path.join(KB, `${NAME}-primer.md`);
fs.writeFileSync(outFile, primer);

// 3-vendor "is this a complete, correct primer?" score (informational; the hard gate is citation count)
const jsys = 'Grade 1-100 whether this repo primer is COMPLETE, CORRECT and CONFIDENT for an engineer new to the repo (98=excellent/actionable; vague-or-hedgy=POISON<50). Return ONLY {"score":N,"reason":"<=15 words"}.';
const scores = [];
for (const j of JUDGES) { try { scores.push(Number(JSON.parse((await or(j, jsys, `PRIMER:\n${primer.slice(0, 9000)}`, 120)).match(/\{[\s\S]*\}/)[0]).score)); } catch { /* skip */ } }
const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : null;
console.log(`\n## ${NAME}-primer.md  [${refs.length >= 6 ? 'GROUNDED' : 'THIN — only ' + refs.length + ' refs'}]`);
console.log(`   verified source refs: ${refs.length}`);
console.log(`   3-vendor primer score: [${scores.join(', ')}] → avg ${avg?.toFixed(1)}`);
console.log(`   written: kb/${NAME}-primer.md`);
