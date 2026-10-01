#!/usr/bin/env node
/**
 * grounding-turn-replay.mjs — measure grounding-turn-gate.mjs's assertion gate (ADR-0030 #1) and its
 * shadow gates (#2 architecture options, #3 relayed numbers) against REAL Claude Code transcripts,
 * read-only. Same turn model and walkers as scripts/completion-claim-replay.mjs (imported, not
 * copied); same pure functions the hooks call (grounding-turn-mark.mjs armFor at the prompt,
 * grounding-turn-evidence.mjs at Stop).
 *
 *   node scripts/grounding-turn-replay.mjs [--root ~/.claude/projects] [--limit 60] [--out blocks.jsonl]
 *        [--grep <regex over the final answer>]
 *
 * STOP POINTS, not turns: every `stop_hook_summary` record in a turn is one real Stop event, judged on
 * the transcript up to that point with the last assistant text before it as `last_assistant_message`
 * — exactly what the hook saw. A turn with no recorded Stop is judged once at its end. As at runtime,
 * only the FIRST stop of an episode may block (stop_hook_active silences the continued stop).
 * `--at <file>:<line>` replays one Stop point (the incident check). `--subagents` also replays
 * subagent transcripts (<session>/subagents/*.jsonl, their sidechain flag cleared) — NOT a runtime
 * surface (the gate is registered on Stop, not SubagentStop); it only widens the labelling sample.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcripts, turnsOf, finalText } from './completion-claim-replay.mjs';
import { armFor } from '../plugin/scripts/grounding-turn-mark.mjs';
import {
  architectureShadow, auditAssertions, loadVocabulary, relayShadow, ruvCapabilityClaims, searchedThisTurn, turnSources,
} from '../plugin/scripts/grounding-turn-evidence.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const root = path.resolve(opt('--root', path.join(os.homedir(), '.claude', 'projects')));
const limit = Number(opt('--limit', '60'));
const out = opt('--out', null);
const grep = opt('--grep', null);
const at = opt('--at', null);
const withSubagents = argv.includes('--subagents');
// --unarmed: judge EVERY stop point as if armed (subjects from the prompt, or none) — measures the
// Stop-side evaluator alone, i.e. what prompt-time arming saves. Not the runtime behaviour.
const unarmed = argv.includes('--unarmed');
function subagentFiles() {
  const files = [];
  for (const project of fs.readdirSync(root)) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(root, project)); } catch { continue; }
    for (const session of sessions) {
      const dir = path.join(root, project, session, 'subagents');
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl') && fs.statSync(path.join(dir, f)).size > 20_000) files.push(path.join(dir, f)); } catch { /* none */ }
    }
  }
  return files;
}

const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const assistantText = (o) => (o?.type === 'assistant' && !o.isSidechain && Array.isArray(o.message?.content)
  ? o.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim() : '');
/** [lines-up-to-stop, last assistant text] for each Stop in a turn (the first per episode only). */
function stopPoints(turnLines) {
  const points = [];
  let last = '';
  let episodeOpen = true;
  turnLines.forEach((l, i) => {
    const o = parse(l);
    const t = assistantText(o);
    if (t) last = t;
    if (o?.type === 'system' && o.subtype === 'stop_hook_summary') {
      if (episodeOpen && last) points.push([turnLines.slice(0, i + 1), last]);
      episodeOpen = false; // later stops in this turn are continuations (stop_hook_active)
    }
  });
  if (!points.length) { const m = finalText(turnLines); if (m) points.push([turnLines, m]); }
  return points;
}

const vocab = loadVocabulary();
if (at) {
  const [file, line] = [at.slice(0, at.lastIndexOf(':')), Number(at.slice(at.lastIndexOf(':') + 1))];
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, line);
  const message = assistantText(parse(lines[lines.length - 1])) || finalText(lines);
  const turn = turnSources(lines);
  const arm = armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'replay', prompt: turn.prompt }, vocab);
  const audit = arm?.assert ? auditAssertions({ message, subjects: arm.subjects, vocab, sources: turn.sources }) : null;
  console.log(JSON.stringify({ at, arm, verdict: audit?.findings.length ? 'BLOCK' : 'PASS', findings: audit?.findings,
    sources: turn.sources.map((x) => `${x.order} ${x.kind} ${x.strength} ${String(x.ref).slice(0, 60)}`) }, null, 2));
  process.exit(0);
}
const r = { root, transcripts: 0, turns: 0, armed: 0, armedGate1: 0, blocked: 0, gate1WouldFire: 0, gate1ArmedUnsearched: 0,
  shadowArchitecture: 0, shadowRelay: 0, claims: 0, ms: [] };
const samples = [];
for (const file of [...transcripts(root, limit), ...(withSubagents ? subagentFiles() : [])]) {
  r.transcripts += 1;
  const sub = file.includes(`${path.sep}subagents${path.sep}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => (sub ? l.replace('"isSidechain":true', '"isSidechain":false') : l));
  for (const [turnLines, message] of turnsOf(lines).flatMap(stopPoints)) {
    r.turns += 1;
    const t0 = performance.now();
    const turn = turnSources(turnLines);
    const arm = unarmed ? { gate1: false, assert: true, architecture: false, subjects: [] }
      : armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'replay', prompt: turn.prompt }, vocab);
    if (!arm) { r.ms.push(performance.now() - t0); continue; }
    // gate1WouldFire = the 4.4.0 rule (an unsearched turn whose answer asserts a rUv capability);
    // gate1ArmedUnsearched = what fired before 4.4.0 (every armed turn without a search).
    if (arm.gate1) {
      r.armedGate1 += 1;
      if (!searchedThisTurn(turn.sources)) {
        r.gate1ArmedUnsearched += 1;
        if (ruvCapabilityClaims(message).length) r.gate1WouldFire += 1;
      }
    }
    let audit = { claims: [], findings: [] };
    if (arm.assert) {
      r.armed += 1;
      audit = auditAssertions({ message, subjects: arm.subjects, vocab, sources: turn.sources });
      r.claims += audit.claims.length;
      if (audit.findings.length) r.blocked += 1;
      if (architectureShadow({ architecture: arm.architecture, message })) r.shadowArchitecture += 1;
      if (relayShadow({ message, sources: turn.sources })) r.shadowRelay += 1;
    }
    r.ms.push(performance.now() - t0);
    const hit = grep && new RegExp(grep, 'i').test(message);
    if (audit.findings.length || hit || (argv.includes('--all-claims') && audit.claims.length)) {
      samples.push({ file: path.basename(file), subagent: sub, grep: !!hit, verdict: audit.findings.length ? 'BLOCK' : 'PASS',
        prompt: turn.prompt.slice(0, 300), subjects: arm.subjects,
        findings: audit.findings.map((f) => ({ claim: f.text.slice(0, 300), subject: f.subject, reason: f.reason, read: f.read })),
        passed: audit.claims.filter((c) => !audit.findings.some((f) => f.text === c.text)).map((c) => ({ claim: c.text.slice(0, 300), subject: c.subject })),
        sources: turn.sources.length });
    }
  }
}
const ms = r.ms.sort((a, b) => a - b);
console.log(JSON.stringify({ ...r, ms: undefined,
  armRate: +(r.armed / (r.turns || 1)).toFixed(3), blockRate: +(r.blocked / (r.turns || 1)).toFixed(4),
  blockRateOfArmed: +(r.blocked / (r.armed || 1)).toFixed(3),
  gate1FireRate: +(r.gate1WouldFire / (r.turns || 1)).toFixed(4),
  shadowArchitectureRate: +(r.shadowArchitecture / (r.turns || 1)).toFixed(4), shadowRelayRate: +(r.shadowRelay / (r.turns || 1)).toFixed(4),
  auditP50Ms: +(ms[Math.floor(ms.length / 2)] || 0).toFixed(2), auditP99Ms: +(ms[Math.floor(ms.length * 0.99)] || 0).toFixed(2),
  unit: 'turns = first Stop point per turn (stop_hook_summary), else turn end', subagents: withSubagents, unarmed }, null, 2));
if (out) fs.writeFileSync(out, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
if (grep) for (const s of samples.filter((x) => x.grep)) console.log(JSON.stringify(s).slice(0, 1500));
