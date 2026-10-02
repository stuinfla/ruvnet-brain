#!/usr/bin/env node
/**
 * agentdb-first-replay.mjs — measure the AgentDB-first pair (ADR-0101) against REAL Claude Code
 * transcripts, read-only: how often agentdb-recall.mjs's trigger fires on real prompts, and how often
 * agentdb-first-gate.mjs would block a real Stop (score asserted, no AgentDB read this turn).
 *
 *   node scripts/agentdb-first-replay.mjs [--root ~/.claude/projects] [--limit 40] [--show]
 *
 * Turn model and transcript walk are completion-claim-replay.mjs's (one turn model, every gate). The
 * turn's final assistant text stands in for last_assistant_message. "Would block" also requires the
 * transcript's own cwd to have an AgentDB store today, as the live gate does. --show prints each
 * would-block line and each triggered prompt (first 100 characters) to stdout for a human to judge;
 * nothing is written anywhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcripts, turnsOf, finalText } from './completion-claim-replay.mjs';
import { scoreAssertions, claudeTurnCalls, readsAgentdb } from '../plugin/scripts/agentdb-first-gate.mjs';
import { recallTrigger, agentdbStores } from '../plugin/scripts/agentdb-recall.mjs';
import { currentTurnRecords } from '../plugin/scripts/completion-claim-evidence.mjs';
import { isHarnessGenerated } from '../plugin/scripts/hook-input.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };

export function replay({ root, limit, show = false, log = console.log }) {
  const r = { root, transcripts: 0, turns: 0, prompts: 0, triggered: 0, scored: 0, scoredRecalled: 0, scoredNoStore: 0, wouldBlock: 0 };
  const storeCache = new Map();
  const hasStore = (cwd) => {
    if (!cwd) return false;
    if (!storeCache.has(cwd)) { let ok = false; try { ok = fs.existsSync(cwd) && agentdbStores(cwd).stores.length > 0; } catch { ok = false; } storeCache.set(cwd, ok); }
    return storeCache.get(cwd);
  };
  for (const file of transcripts(root, limit)) {
    r.transcripts += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const turnLines of turnsOf(lines)) {
      const { prompt } = currentTurnRecords(turnLines);
      let cwd = '';
      try { cwd = JSON.parse(turnLines[0]).cwd || ''; } catch { /* torn */ }
      if (prompt && !isHarnessGenerated(prompt)) {
        r.prompts += 1;
        const t = recallTrigger(prompt);
        if (t) { r.triggered += 1; if (show) log(`TRIGGER ${t.kinds.join(',')}: ${prompt.replace(/\s+/g, ' ').slice(0, 100)}`); }
      }
      const message = finalText(turnLines);
      if (!message) continue;
      r.turns += 1;
      const claims = scoreAssertions(message);
      if (!claims.length) continue;
      r.scored += 1;
      if (readsAgentdb(claudeTurnCalls(turnLines).calls)) { r.scoredRecalled += 1; continue; }
      if (!hasStore(cwd)) { r.scoredNoStore += 1; if (show) log(`SCORED(no store) ${claims[0].kind}: ${claims[0].text.slice(0, 120)}`); continue; }
      r.wouldBlock += 1;
      if (show) log(`WOULD-BLOCK ${claims[0].kind}: ${claims[0].text.slice(0, 120)}`);
    }
  }
  return { ...r, triggerRate: r.prompts ? +(r.triggered / r.prompts).toFixed(3) : 0,
    blockRate: r.turns ? +(r.wouldBlock / r.turns).toFixed(4) : 0,
    approximation: 'final assistant text of each turn stands in for last_assistant_message' };
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const summary = replay({ root: path.resolve(opt('--root', path.join(os.homedir(), '.claude', 'projects'))),
    limit: Number(opt('--limit', '40')), show: argv.includes('--show') });
  console.log(JSON.stringify(summary, null, 2));
}
