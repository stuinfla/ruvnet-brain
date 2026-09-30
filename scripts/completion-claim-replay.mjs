#!/usr/bin/env node
/**
 * completion-claim-replay.mjs — measure the completion-claim gate and promise capture against REAL
 * Claude Code transcripts, read-only (ADR-074 acceptance #5: "Measure Stop latency and false-positive
 * rate").
 *
 * It replays every turn of every top-level `*.jsonl` under the transcript root through the SAME pure
 * functions continuation-gate.mjs calls at Stop (plugin/scripts/completion-claim-evidence.mjs), and
 * reports how often the gate would ARM (a completion claim is present), BLOCK (FAIL verdict) and
 * capture a PROMISE. It never writes into the transcript root; `--out` writes a JSONL sample of
 * blocks and promises for a human to label true/false by eye.
 *
 *   node scripts/completion-claim-replay.mjs [--root ~/.claude/projects] [--limit 40] [--out file.jsonl]
 *
 * Turn = records from one genuine user message to the next; the turn's final assistant text stands
 * in for the Stop payload's `last_assistant_message`. That approximation is disclosed in the report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCompletionClaims, claudeTurnEvents, extractCommitments } from '../plugin/scripts/completion-claim-evidence.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };

// The transcript walkers below are exported for scripts/grounding-turn-replay.mjs (one turn model,
// two gates); main() runs only when this file is the entrypoint.
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c)
  ? c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '');

export function transcripts(root, limit) {
  const files = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    try {
      for (const name of fs.readdirSync(full)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(full, name);
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 20_000) files.push({ file, mtime: st.mtimeMs });
      }
    } catch { /* not a directory */ }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.file);
}

export function turnsOf(lines) {
  const starts = [];
  lines.forEach((l, i) => {
    try {
      const o = JSON.parse(l);
      const c = o?.message?.content;
      const toolResult = Array.isArray(c) && c.some((x) => x?.type === 'tool_result');
      if (o?.type === 'user' && !o.isSidechain && !o.isMeta && !toolResult && textOf(c).trim()) starts.push(i);
    } catch { /* torn */ }
  });
  return starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length));
}

export function finalText(turnLines) {
  for (let i = turnLines.length - 1; i >= 0; i -= 1) {
    try {
      const o = JSON.parse(turnLines[i]);
      if (o?.type === 'assistant' && !o.isSidechain) { const t = textOf(o.message?.content).trim(); if (t) return t; }
    } catch { /* torn */ }
  }
  return '';
}

function main() {
  const root = path.resolve(opt('--root', path.join(os.homedir(), '.claude', 'projects')));
  const limit = Number(opt('--limit', '40'));
  const out = opt('--out', null);
  const report = { root, transcripts: 0, turns: 0, armed: 0, blocked: 0, passed: 0, promises: 0, turnsWithPromise: 0,
    reasons: {}, auditMs: [] };
  const samples = [];
  for (const file of transcripts(root, limit)) {
    report.transcripts += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const turnLines of turnsOf(lines)) {
      const message = finalText(turnLines);
      if (!message) continue;
      report.turns += 1;
      const t0 = performance.now();
      const audit = auditCompletionClaims(message, { turn: claudeTurnEvents(turnLines) });
      report.auditMs.push(performance.now() - t0);
      const promises = extractCommitments(message);
      if (promises.length) { report.turnsWithPromise += 1; report.promises += promises.length; }
      if (audit.verdict !== 'NONE') report.armed += 1;
      if (audit.verdict === 'PASS') report.passed += 1;
      if (audit.verdict === 'FAIL') {
        report.blocked += 1;
        for (const p of audit.problems) { const k = p.replace(/\(.*\)/, '').trim(); report.reasons[k] = (report.reasons[k] || 0) + 1; }
      }
      if (audit.verdict === 'FAIL' || promises.length) {
        samples.push({ file: path.basename(file), verdict: audit.verdict, claims: audit.claims.map((c) => c.text),
          problems: audit.problems, promises: promises.map((p) => p.text), tail: message.slice(-700) });
      }
    }
  }
  const ms = report.auditMs.sort((a, b) => a - b);
  const summary = { ...report, auditMs: undefined,
    armRate: report.turns ? +(report.armed / report.turns).toFixed(3) : 0,
    blockRate: report.turns ? +(report.blocked / report.turns).toFixed(3) : 0,
    promiseTurnRate: report.turns ? +(report.turnsWithPromise / report.turns).toFixed(3) : 0,
    auditP50Ms: +(ms[Math.floor(ms.length / 2)] || 0).toFixed(2), auditP99Ms: +(ms[Math.floor(ms.length * 0.99)] || 0).toFixed(2),
    approximation: 'final assistant text of each turn stands in for last_assistant_message' };
  if (out) fs.writeFileSync(out, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main();
