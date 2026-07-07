#!/usr/bin/env node
// brain-grade-groundtruth.mjs — the ADR-0002 gate of record.
// For each question: (1) run the REAL consumer path (searchKb) → top-k cited source;
// (2) MECHANICAL ground-truth: does the #1 cited path actually exist in the repo clone?
// (3) MULTI-VENDOR panel: independent-vendor LLMs (GPT, Gemini — different families from the
//     builder) grade STRICT (#1 doc alone) + REAL-USE (top-5) 1-100 against the RETURNED SOURCE,
//     with the poison rule (incomplete-but-not-wrong < 50). No same-family LLM is the final word.
// Emits a JSON report + console summary with REAL NUMBERS. Never claims PASS itself — prints the data.
//
//   node scripts/brain-grade-groundtruth.mjs --name ruflo --variant big \
//        --questions kb/questions.ruflo.json --repo ../ruvnet-repos/ruflo   (or set RUVNET_REPO)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKb } from '../kb/forge-ask.mjs';
import { rerankKb } from '../kb/forge-rerank.mjs';
const RERANK = process.argv.includes('--rerank');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NAME = arg('--name', 'ruflo');
const VARIANT = arg('--variant', 'big');
const QFILE = arg('--questions', path.join(ROOT, 'kb/questions.ruflo.json'));
const REPO = arg('--repo', process.env.RUVNET_REPO || path.join(ROOT, '..', 'ruvnet-repos', NAME));
const MODELS = (arg('--models', 'openai/gpt-4o-mini,deepseek/deepseek-chat,meta-llama/llama-3.3-70b-instruct')).split(',').map(s => s.trim()).filter(Boolean);

// OpenRouter key (presence already confirmed) — read from env or Ask-Ruvnet .env; never logged.
function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = fs.readFileSync((process.env.RUVNET_ENV_FILE || '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m); return m ? m[1].trim() : null;
  } catch { return null; }
}
const KEY = readKey();
const clip = (s, n = 2600) => (s && s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} chars]` : (s || ''));

async function gradeWith(model, q, strictEvidence, realUseEvidence) {
  const sys = 'You are a STRICT senior code reviewer grading whether a knowledge-base answer is COMPLETE and CORRECT, judged ONLY against the retrieved source shown. Scale 1-100: 98=perfect/complete/actionable; an INCOMPLETE-but-not-wrong answer is POISON (<50). If the source does not actually answer the question, score low. Return ONLY compact JSON: {"strict":N,"realUse":N,"reason":"<=20 words"}.';
  const usr = `QUESTION: ${q}\n\n--- STRICT: the #1 retrieved document ALONE ---\n${strictEvidence}\n\n--- REAL-USE: the top-5 documents a consumer would synthesize ---\n${realUseEvidence}\n\nGrade STRICT (can the #1 doc alone fully answer?) and REAL-USE (can the top-5 together?).`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0, max_tokens: 200 }),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}`);
  const j = await res.json();
  const txt = j.choices?.[0]?.message?.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${model} no-json`);
  const o = JSON.parse(m[0]);
  return { strict: Number(o.strict), realUse: Number(o.realUse), reason: String(o.reason || '').slice(0, 120) };
}

const questions = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
if (!KEY) { console.error('No OPENROUTER_API_KEY — cannot run multi-vendor panel.'); process.exit(2); }
console.log(`# Ground-truth + multi-vendor grade — ${NAME} [${VARIANT}] — ${questions.length} Q × ${MODELS.length} vendors\n`);

const report = [];
for (let i = 0; i < questions.length; i++) {
  const q = questions[i].q;
  const results = RERANK
    ? await rerankKb({ dir: path.join(ROOT, 'kb'), name: NAME, query: q, k: 6, variant: VARIANT })
    : await searchKb({ dir: path.join(ROOT, 'kb'), name: NAME, query: q, k: 6, variant: VARIANT });
  const top = results[0];
  const gt = top ? fs.existsSync(path.join(REPO, top.path)) : false;   // mechanical ground-truth: cited path real?
  const strictEv = top ? `path: ${top.path}\n${clip(top.fullText)}` : '(no results)';
  const realUseEv = results.slice(0, 5).map((r, j) => `${j + 1}. ${r.path}\n${clip(r.fullText, 1100)}`).join('\n\n');
  const grades = [];
  for (const model of MODELS) {
    try { grades.push({ model, ...await gradeWith(model, q, strictEv, realUseEv) }); }
    catch (e) { grades.push({ model, error: e.message }); }
  }
  const ok = grades.filter(g => Number.isFinite(g.strict));
  const avgS = ok.length ? ok.reduce((s, g) => s + g.strict, 0) / ok.length : null;
  const avgR = ok.length ? ok.reduce((s, g) => s + g.realUse, 0) / ok.length : null;
  report.push({ q, topPath: top?.path || null, groundTruthPathExists: gt, grades, avgStrict: avgS, avgRealUse: avgR });
  console.log(`Q${i + 1}. ${q}`);
  console.log(`   #1: ${top?.path || '(none)'}  | path-exists: ${gt ? 'YES' : 'NO'}`);
  for (const g of grades) console.log(`   ${g.model}: ${g.error ? 'ERR ' + g.error : `strict=${g.strict} realUse=${g.realUse} — ${g.reason}`}`);
  console.log(`   → avg strict=${avgS?.toFixed(1) ?? '?'} realUse=${avgR?.toFixed(1) ?? '?'}\n`);
}

// Aggregate
const valid = report.filter(r => Number.isFinite(r.avgStrict));
const mean = (k) => valid.reduce((s, r) => s + r[k], 0) / valid.length;
const minK = (k) => Math.min(...valid.map(r => r[k]));
const gtFail = report.filter(r => !r.groundTruthPathExists).length;
const summary = {
  name: NAME, variant: VARIANT, questions: questions.length, models: MODELS,
  avgStrict: +mean('avgStrict').toFixed(2), avgRealUse: +mean('avgRealUse').toFixed(2),
  minStrict: minK('avgStrict'), minRealUse: minK('avgRealUse'),
  poisonStrict: valid.filter(r => r.avgStrict < 50).length, poisonRealUse: valid.filter(r => r.avgRealUse < 50).length,
  groundTruthCitationFailures: gtFail,
};
fs.writeFileSync(path.join(ROOT, `data/grade-${NAME}-${VARIANT}.json`), JSON.stringify({ summary, report }, null, 2));
console.log('=== SUMMARY (real numbers) ===');
console.log(JSON.stringify(summary, null, 2));
console.log(`\nGate (ADR-0002): PASS needs avg>=98 AND min>=95 on BOTH metrics, 0 poison, 0 citation failures.`);
console.log(`Report: data/grade-${NAME}-${VARIANT}.json`);
