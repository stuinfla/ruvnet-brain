#!/usr/bin/env node
/**
 * deferral-replay.mjs — measure continuation-gate's `no-deferral` check (ADR-106) on REAL Claude Code
 * transcripts, read-only. Same turn model as completion-claim-replay.mjs: a turn runs from one genuine
 * user message to the next and its final assistant text stands in for `last_assistant_message`;
 * authorization is read from the owner prompts up to and including that turn.
 *
 *   node scripts/deferral-replay.mjs [--root ~/.claude/projects] [--limit 60] [--skip 0] [--out sample.jsonl]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcripts, turnsOf, finalText } from './completion-claim-replay.mjs';
import { auditDeferral, ownerPrompts } from '../plugin/scripts/deferral-evidence.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const root = path.resolve(opt('--root', path.join(os.homedir(), '.claude', 'projects')));
const limit = Number(opt('--limit', '60'));
const skip = Number(opt('--skip', '0')); // held-out evaluation: skip the newest N transcripts
const out = opt('--out', null);
const report = { root, transcripts: 0, turns: 0, deferralPhrase: 0, blocked: 0, unauthorized: 0, forced: 0, byKind: {} };
const samples = [];
for (const file of transcripts(root, skip + limit).slice(skip)) {
  report.transcripts += 1;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const prompts = [];
  for (const turn of turnsOf(lines)) {
    report.turns += 1;
    prompts.push(...ownerPrompts(turn.slice(0, 1)));
    const message = finalText(turn);
    if (!message) continue;
    const v = auditDeferral(message, { prompts });
    if (v.verdict === 'NONE') continue;
    report.deferralPhrase += 1;
    if (v.verdict === 'BLOCKER') report.blocked += 1;
    if (v.verdict === 'UNAUTHORIZED') report.unauthorized += 1;
    if (v.verdict === 'DEFERRAL') {
      report.forced += 1;
      report.byKind[v.deferral.kind] = (report.byKind[v.deferral.kind] || 0) + 1;
      samples.push({ file: path.basename(file), phrase: v.deferral.phrase, authorization: v.authorization, tail: message.slice(-500) });
    }
  }
}
report.forcedRate = report.turns ? Number((report.forced / report.turns).toFixed(4)) : 0;
if (out) fs.writeFileSync(out, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
console.log(JSON.stringify(report, null, 2));
