#!/usr/bin/env node
/**
 * agentdb-first-gate.mjs — Stop-time enforcement of "ALWAYS CHECK AGENTDB FIRST" (owner requirement
 * R15, 2026-10-02; ADR-0101).
 *
 * agentdb-recall.mjs puts the owner's records in front of the model at UserPromptSubmit. That is a
 * directive, and a directive is advisory (rUv's ADR-G007: "prompts are advisory"). This gate is the
 * check: when the turn's FINAL ANSWER asserts a score, grade or rating (`46/100`, "I'd score it 7/10",
 * "Grade: B+", "Overall: 72%", a pillar table with a Score column) and NOTHING in the same turn read
 * AgentDB, the turn is continued ONCE with the exact recall commands.
 *
 * WHAT COUNTS AS READING AGENTDB this turn: a Bash call running `ruflo|claude-flow memory
 * search|retrieve|list`, `continuity-brief.mjs`, or sqlite3 on a .swarm memory db; an MCP call to
 * memory_search / memory_search_unified / memory_retrieve / memory_list. (agentdb_hierarchical-recall
 * is deliberately NOT counted: it reads a different, empty container — the owner's measured footgun.)
 * The injected recall block alone does not count on Claude: it carries 48-character previews, and the
 * failure being prevented is a score assembled without the records' content.
 *
 * EVIDENCE, PER HOST — reusing what the other Stop gates already trust:
 *   Claude: the transcript's current turn (completion-claim-evidence.mjs currentTurnRecords, the same
 *           turn boundary continuation-gate and grounding-turn-gate use), read as a bounded tail.
 *   Codex:  the rollout at transcript_path, current turn = after the last `task_started` event; tool
 *           calls are `custom_tool_call` (input) and `function_call` (name + arguments).
 *   When the turn's start is not inside the tail (or there is no transcript), absence of a recall
 *   cannot be proven: Codex then accepts agentdb-recall's per-session receipt as evidence, and
 *   otherwise the gate stays silent — it never blocks on a guess.
 *
 * LOOP SAFETY (identical to grounding-turn-gate / continuation-gate): only an affirmatively parsed
 * stdin payload with a session id may force; stop_hook_active, interrupted and cancelled are silent;
 * and a per-session receipt keyed by the turn makes it at most ONE block per turn even on a host that
 * does not set stop_hook_active. Total no-op (zero bytes) when the project has no AgentDB store or
 * RUVNET_AGENTDB_FIRST=off. Independent of lesson-gate and blocking-optin.json: this is a product
 * gate, not a lesson the model ratified for itself.
 *
 * FAILS OPEN ALWAYS. Exit 0 unconditionally; the block is the stdout envelope
 * (hookSpecificOutput.additionalContext), which codex-hook-adapter translates to Codex's
 * decision:block exactly as for the other Stop gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readStopHookInput } from './hook-input.mjs';
import { currentTurnRecords } from './completion-claim-evidence.mjs';
import { readSettledTranscript } from './turn-outcome-capture.mjs';
import { agentdbFirstEnabled, agentdbStores, recallMarkerPath } from './agentdb-recall.mjs';

// ── WHAT IS A SCORE ASSERTION ───────────────────────────────────────────────────────────────────────
// Precision first (measured on real transcripts by scripts/agentdb-first-replay.mjs; the numbers are
// in ADR-0101). A count of tests, files, turns or repos out of 100 is not a judgement; neither is a
// similarity score of 0.63 or a recall@10 of 0.98.
const COUNT_NOUN = /^\s*(?:\*\*)?\s*(?:tests?|specs?|suites?|pass(?:ed|es|ing)?|fail(?:ed|s|ing|ures?)?|skipped|files?|cases?|turns?|runs?|prompts?|items?|lines?|checks?|samples?|quer(?:y|ies)|records?|rows?|repos?|stores?|entries|requests?|commits?|jobs?|steps?|hits?|matches|queries|chunks?|docs?|pages?|tokens?|ms|seconds?|s\b|%|of (?:the|them|those))/i;
const COUNT_CONTEXT = /\b(?:tests?|passed|passing|failed|failing|skipped|suites?|recall@|hit@|precision|coverage|accuracy|latency|cpu|memory|disk|bytes?|tokens?|turns?|prompts?|files?|repos?|stores?|chunks?)\b/i;
const SCORE_WORD = /\b(?:score[ds]?|scoring|scorecard|grade[ds]?|grading|rat(?:ed|ing)|overall|composite|total|pillars?|rubric|north[ -]?star|readiness|maturity|verdict|mean|average|projected|net result|claimed|i'?d (?:give|put|score|rate))\b/i;
const STRONG_SCORE_WORD = /\b(?:score[ds]?|scoring|scorecard|grade[ds]?|grading|rat(?:ed|ing)|overall|north[ -]?star|rubric|pillars?|i'?d (?:give|put|score|rate))\b/i;
const THRESHOLD_AFTER = /^\s*(?:\+|\)?\s*(?:claim|proof|verification|verified|target|goal|bar|threshold|gate|unlock|binding|minimum|requirement)\b)/i;
const THRESHOLD_BEFORE = /(?:target(?:ing|ed|s)?|goal|need(?:s|ed)?|reach(?:es|ed|ing)?|hit(?:s|ting)?|toward(?:s)?|path to|unlock(?:s)?|blockers? for|at least|minimum|min\.?|above|below|under|over|ship(?:s|ped)? (?:if|at|when)|if (?:the )?(?:score|both|it|we)\b[^.]*?|up to|(?:days?|weeks?|path|way|road|route) to|(?:date|time|eta|timeline|plan|roadmap|deadline) for|\bif\s+\d+\s*[-–]|\bnot|\bon|≥|>=|>|<|≤|<=)\s*[:(]?\s*\**\s*$/i;

/** Score/grade/rating assertions in a final answer: [{ text, kind }]. */
export function scoreAssertions(rawMessage) {
  const message = String(rawMessage || '').replace(/```[\s\S]*?```/g, ' ');   // code is not prose
  const found = [];
  const lines = message.split(/\r?\n/);
  for (const line of lines) {
    if (found.length >= 3) break;
    const l = line.slice(0, 600);
    // A question proposes; a heading naming an option/target/goal frames. Neither asserts a score.
    if (/\?\s*\**\s*$/.test(l) || /^\s*#{1,6}\s.*\b(?:option|target|goal|path|plan|scenario)\b/i.test(l)) continue;
    // (1) N/100 or N out of 100 (also /10) with a score word on the line and no count context.
    for (const m of l.matchAll(/(?<![\w.@/])(\d{1,3}(?:\.\d)?)\+?\s*(?:\/\s*|out of\s+)(100|10)(?!\.?\d)(?![\w/])/gi)) {
      const after = l.slice(m.index + m[0].length, m.index + m[0].length + 24);
      const before = l.slice(Math.max(0, m.index - 28), m.index);
      if (Number(m[1]) > Number(m[2])) continue;
      if (COUNT_NOUN.test(after)) continue;
      // A target or threshold ("need 95/100", "ship if >90/100", "path to 98/100") states a goal, not a score.
      if (THRESHOLD_BEFORE.test(before) || THRESHOLD_AFTER.test(l.slice(m.index + m[0].length - 0, m.index + m[0].length + 24))) continue;
      if (!(m[2] === '10' ? STRONG_SCORE_WORD : SCORE_WORD).test(l) && !(m[2] === '100' && /^\s*#{1,6}\s/.test(l))) continue;
      if (COUNT_CONTEXT.test(l) && !STRONG_SCORE_WORD.test(l)) continue;
      found.push({ kind: 'score', text: l.trim().slice(0, 160) });
      break;
    }
    if (found.at(-1)?.text === l.trim().slice(0, 160)) continue;
    // (2) a letter grade stated as one: "Grade: B+", "graded it an A-", "overall grade C".
    if (/\bgrade(?:d)?\b(?:\s+(?:it|this|the \w+))?\s*(?::|=|—|-|of|is|as|an?)\s*\**\s*[A-F][+-]?(?![\w])/i.test(l)
      && !/\bgrade(?:d)?\s+(?:a|an)\s+(?!\**[A-F][+-]?\**(?:\s|[.,;:)]|$))/i.test(l)) {
      found.push({ kind: 'grade', text: l.trim().slice(0, 160) }); continue;
    }
    // (3) "Overall: 72%" / "readiness 80%" — a judgement as a percentage.
    if (/\b(?:overall|composite|readiness|maturity)(?:\s+(?:score|grade|rating))?\s*(?::|=|—|-|is|at|of)?\s*\**\s*\d{1,3}(?:\.\d)?\s*%/i.test(l)
      && !COUNT_CONTEXT.test(l.replace(/\b(?:overall|composite|readiness|maturity)\b/gi, ''))) {
      found.push({ kind: 'percent', text: l.trim().slice(0, 160) });
    }
  }
  // (4) a pillar/score table: a header row with a Score/Grade/Rating column and ≥2 numeric rows in it.
  if (!found.length) {
    for (let i = 0; i + 2 < lines.length; i += 1) {
      const head = lines[i];
      if (!/^\s*\|/.test(head) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
      const cols = head.split('|').map((c) => c.trim().toLowerCase());
      const col = cols.findIndex((c) => /^(?:\**)?(?:score|grade|rating|points|\/100|score \/100|score \(\/100\))(?:\**)?$/.test(c));
      if (col < 0) continue;
      let numeric = 0;
      for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j += 1) {
        const cell = (lines[j].split('|')[col] || '').replace(/\*/g, '').trim();
        if (/^\d{1,3}(?:\.\d)?(?:\s*\/\s*\d{1,3})?$|^[A-F][+-]?$/.test(cell)) numeric += 1;
      }
      if (numeric >= 2) { found.push({ kind: 'table', text: head.trim().slice(0, 160) }); break; }
    }
  }
  return found;
}

// ── WHAT IS READING AGENTDB ─────────────────────────────────────────────────────────────────────────
export const READ_COMMAND = /\b(?:ruflo|claude-flow)(?:@[\w.-]+)?\s+(?:--?[\w-]+(?:[ =]\S+)?\s+)*memory\s+(?:search|retrieve|list|get|query|recall)\b|continuity-brief\.mjs|\bsqlite3\b[^\n|;&]*\.swarm\/(?:agentdb-)?memory\.db/i;
export const READ_MCP = /(?:^|__)(?:memory_(?:search|search_unified|retrieve|list))$/;

/** Did any of these tool calls read AgentDB? `calls` = [{ name, input }] (input: object or string). */
export function readsAgentdb(calls) {
  for (const c of calls || []) {
    const name = String(c?.name || '');
    const input = typeof c?.input === 'string' ? c.input : JSON.stringify(c?.input ?? '');
    if (READ_MCP.test(name)) return true;
    if (/^(?:Bash|exec|exec_command|shell|local_shell|container\.exec)$/i.test(name) || /Bash|exec|shell/i.test(name)) {
      if (READ_COMMAND.test(input)) return true;
    }
    if (/memory_(?:search|retrieve|list)/.test(name)) return true;
  }
  return false;
}

/** Claude transcript lines → { boundaryFound, calls, turnId }. */
export function claudeTurnCalls(lines) {
  const { boundaryFound, prompt, recs } = currentTurnRecords(lines);
  const calls = [];
  for (const o of recs) {
    const c = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const u of c) if (u?.type === 'tool_use') calls.push({ name: u.name, input: u.input || {} });
  }
  return { boundaryFound, calls, turnId: hash(prompt) };
}

/** Codex rollout lines → { boundaryFound, calls, turnId }. Current turn = after the last task_started. */
export function codexTurnCalls(lines) {
  const recs = [];
  for (const l of lines || []) { try { recs.push(JSON.parse(l)); } catch { /* torn line */ } }
  let start = -1;
  recs.forEach((o, i) => { if (o?.type === 'event_msg' && o?.payload?.type === 'task_started') start = i; });
  const calls = [];
  for (const o of recs.slice(start + 1)) {
    const p = o?.payload;
    if (o?.type !== 'response_item' || !p) continue;
    if (p.type === 'custom_tool_call') calls.push({ name: String(p.name || 'exec'), input: String(p.input ?? '') });
    else if (p.type === 'function_call' || p.type === 'mcp_tool_call') calls.push({ name: String(p.name || ''), input: String(p.arguments ?? JSON.stringify(p.input ?? '')) });
  }
  const startRec = start >= 0 ? recs[start] : null;
  return { boundaryFound: start >= 0, calls, turnId: hash(JSON.stringify(startRec?.payload ?? '') + (startRec?.timestamp || '')) };
}

function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

function readRecallMarker(sessionId, env) {
  const file = recallMarkerPath(sessionId, env);
  if (!file) return null;
  try { return { ...JSON.parse(fs.readFileSync(file, 'utf8')), mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
}

/** The correction text. Names the recalled keys when the UserPromptSubmit recall left a receipt. */
export function correctionText({ claims, stores, marker }) {
  const keys = (marker?.keys || []).slice(0, 4).map((k) => `${k.key} [${k.namespace}] (${k.store})`);
  const store = stores[0];
  return [
    `You gave a score without recalling AgentDB first: "${claims[0].text}".`,
    'The owner\'s rule (R15): ALWAYS CHECK AGENTDB FIRST — his recorded plan, earlier scorecards and decisions',
    'outrank README/docs, and a score that ignores them is a fail. Nothing this turn read either store.',
    `Run now, for BOTH stores (${stores.map((s) => s.path).join(' and ')}):`,
    `  ruflo memory search --path ${store.path} -q "plan scorecard decision north star requirement" --limit 10`,
    ...(stores[1] ? [`  ruflo memory search --path ${stores[1].path} -q "plan scorecard decision north star requirement" --limit 10`] : []),
    `  ruflo memory retrieve -k <key> -n <namespace> --path <store>   (read the full plan and the latest scorecards)`,
    ...(keys.length ? [`Already recalled for this prompt: ${keys.join('; ')}.`] : []),
    'Then redo the answer against the owner\'s recorded plan and scorecards, and say where it differs from them and why.',
  ].join('\n');
}

/**
 * The whole Stop decision: the correction text, or null. Pure apart from the reads it is handed.
 * `read(file)` returns transcript lines.
 */
export function decide({ hookInput, env = process.env, read = (f) => readSettledTranscript(f, { maxMs: 0 }), projectDir } = {}) {
  try {
    if (!agentdbFirstEnabled(env)) return { text: null, why: 'disabled' };
    const message = String(hookInput.last_assistant_message || '');
    const claims = scoreAssertions(message);
    if (!claims.length) return { text: null, why: 'no-score' };
    const { stores } = agentdbStores(projectDir || hookInput.cwd || process.cwd());
    if (!stores.length) return { text: null, why: 'no-store' };
    const host = env.RUVNET_HOOK_HOST === 'codex' ? 'codex' : 'claude';
    const tp = hookInput.transcript_path;
    let turn = null;
    if (typeof tp === 'string' && /\.jsonl$/i.test(tp)) {
      try { const lines = read(tp); turn = host === 'codex' ? codexTurnCalls(lines) : claudeTurnCalls(lines); } catch { turn = null; }
    }
    const marker = readRecallMarker(hookInput.session_id, env);
    if (!turn || !turn.boundaryFound) {
      // Absence cannot be proven. Codex: the product's own recall receipt is the evidence we have.
      return { text: null, why: host === 'codex' && marker ? 'codex-recall-receipt' : 'unverifiable', claims };
    }
    if (readsAgentdb(turn.calls)) return { text: null, why: 'recalled', claims };
    return { text: correctionText({ claims, stores, marker }), why: 'block', claims, turnId: turn.turnId };
  } catch { return { text: null, why: 'error' }; }
}

/** At most one block per turn per session, even on a host that does not set stop_hook_active. */
function alreadyBlocked(sessionId, turnId, env) {
  const file = recallMarkerPath(`${sessionId}-gate`, env);
  if (!file) return true;
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).turnId === turnId) return true; } catch { /* first time */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ turnId, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch { /* cannot record → still block once now; stop_hook_active guards the continuation */ }
  return false;
}

async function main() {
  const hookInput = await readStopHookInput();
  if (hookInput.__source !== 'stdin' || hookInput.stop_hook_active) process.exit(0);
  if (hookInput.hook_event_name !== 'Stop') process.exit(0);
  if (hookInput.interrupted || hookInput.cancelled || !hookInput.session_id) process.exit(0);
  const verdict = decide({ hookInput });
  if (!verdict.text || alreadyBlocked(hookInput.session_id, verdict.turnId, process.env)) process.exit(0);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: verdict.text } }));
  process.exit(0);
}

function isMain() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMain()) main().catch(() => process.exit(0));
